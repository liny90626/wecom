import crypto from "node:crypto";

import {
  generateReqId,
  type WsFrame,
  type BaseMessage,
  type EventMessage,
  type WSClient,
} from "@wecom/aibot-node-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import { resolveWecomMediaMaxBytes, resolveWecomMergedMediaLocalRoots } from "../../config/index.js";
import { getBotWsPushHandle, getWecomRuntime } from "../../runtime.js";
import { isRetryableReplySessionAdmissionError } from "../../shared/reply-errors.js";
import type { ReplyHandle, ReplyPayload } from "../../types/index.js";
import {
  chunkFormattedWeComMarkdownV2,
  toWeComMarkdownV2,
} from "../../wecom_msg_adapter/markdown_adapter.js";
import { uploadAndSendBotWsMedia } from "./media.js";

const PLACEHOLDER_RETRY_MS = 3000;
const LONG_TASK_STATUS_AFTER_MS = 8 * 60_000;
const B2_PEER_FINAL_DEDUP_TTL_MS = 120_000;
const WECOM_STREAM_MAX_CHARS = 3_500;
const WECOM_STREAM_FINAL_MAX_CHARS = 2_000;
const WECOM_STREAM_MAX_BYTES = 12_000;
const BLOCK_PREVIEW_MAX_MS = 300_000;
const BLOCK_PREVIEW_MAX_CHARS = 3_000;
const BLOCK_PREVIEW_MIN_UPDATE_MS = 1_500;
/** How often the long-task status line may repaint, on ANY lane. */
const LONG_TASK_STATUS_INTERVAL_MS = 60_000;
const THINKING_PREVIEW_MIN_UPDATE_MS = 3_000;
const WECOM_REPLY_SEND_TIMEOUT_MS = 8_000;
const WECOM_PENDING_ACK_GRACE_MS = 5_500;
const WECOM_PENDING_ACK_POLL_MS = 100;
const THINKING_BLOCK_MAX_CHARS = 3_000;
const THINKING_BLOCK_MAX_BYTES = 8_000;
/** `<think></think>` plus its trailing newline costs around the content. */
const THINK_BLOCK_WRAPPER_CHARS = 16;
const THINK_BLOCK_WRAPPER_BYTES = 16;
const LONG_FINAL_DEDUP_MIN_CHARS = 3_000;
const LONG_FINAL_DEDUP_MIN_SEGMENT_CHARS = 120;
const STRUCTURED_TAIL_MIN_DUPLICATE_LINES = 4;
const FINAL_COMPLETION_MARKER = "（回复完毕）";
const LONG_TASK_STATUS_PREFIX = "【长任务处理中，请勿打断，已用时";
const PREVIEW_WATCHDOG_MAX_MS = 60 * 60 * 1000;
const PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS = LONG_TASK_STATUS_AFTER_MS;
const REPLY_FAIL_NOTICE_TEXT = "⚠️ 本次回复投递中断，请稍后重试或重新发起提问。";
const REPLY_MODEL_TIMEOUT_NOTICE_TEXT = "⚠️ 模型响应超时，本次任务未完成，请稍后重试。";
const REPLY_PREPARE_TIMEOUT_NOTICE_TEXT =
  "⚠️ 会话准备超时，本条消息尚未开始处理，请稍后重新发送。";
const REPLY_SESSION_INIT_CONFLICT_NOTICE_TEXT =
  "上一轮任务还在处理中或会话状态刚发生变化，这条消息未能处理，请稍后重新发送。";
const FINAL_PUSH_RETRY_BASE_MS = 20_000;
const FINAL_PUSH_MAX_RETRIES = 3;
const THINK_TAG_RE = /<\/?think>/gi;
const OPEN_THINK_TAG_RE = /<think>/gi;
const CLOSE_THINK_TAG_RE = /<\/think>/gi;
const B3_SUPERSEDED_NOTICE_TEXT = "已收到新消息，合并思考。✅";
const B3_SUPERSEDED_UNMERGED_NOTICE_TEXT =
  "已收到新消息，本条尚未开始处理，如仍需要请重新发送。";
const B3_MEDIA_SUPERSEDED_NOTE = "本次回复包含文件，因会话已合并，文件请在新消息中重新发送或确认后重试。";

type PreviewSuffixParams = {
  prefix: string;
  suffix: string;
  separator?: string;
  maxChars: number;
  maxBytes: number;
};

type RenderedPreviewSource = {
  text: string;
  sourceText: string;
};

function fitsPreviewWireBudget(text: string, maxChars: number, maxBytes: number): boolean {
  return text.length <= maxChars && Buffer.byteLength(text, "utf8") <= maxBytes;
}

function renderPreviewSourcePrefixWithinLimits(params: {
  sourceText: string;
  maxChars: number;
  maxBytes: number;
}): RenderedPreviewSource {
  const sourceText = params.sourceText.trimEnd();
  if (sourceText.length === 0 || params.maxChars <= 0 || params.maxBytes <= 0) {
    return { text: "", sourceText: "" };
  }

  const render = (sourcePrefix: string): string =>
    escapeLiteralThinkTags(toWeComMarkdownV2(sourcePrefix, null).trimEnd());
  const fullText = render(sourceText);
  if (fitsPreviewWireBudget(fullText, params.maxChars, params.maxBytes)) {
    return { text: fullText, sourceText };
  }

  // Find a source prefix that fits after Markdown normalization and literal
  // thinking-tag escaping. The returned source prefix is the same input used
  // to render the visible text, so delivery bookkeeping cannot over-claim.
  const maxSourceChars = Math.min(sourceText.length, params.maxChars);
  const boundaries = [0];
  for (let offset = 0; offset < maxSourceChars; ) {
    const codePoint = sourceText.codePointAt(offset) ?? 0;
    offset += codePoint > 0xffff ? 2 : 1;
    boundaries.push(offset);
  }

  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = render(sourceText.slice(0, boundaries[middle]));
    if (fitsPreviewWireBudget(candidate, params.maxChars, params.maxBytes)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  let visibleSourceText = sourceText.slice(0, boundaries[low]).trimEnd();
  let visibleText = render(visibleSourceText);
  while (
    visibleSourceText &&
    !fitsPreviewWireBudget(visibleText, params.maxChars, params.maxBytes)
  ) {
    visibleSourceText = visibleSourceText.slice(0, -1).trimEnd();
    visibleText = render(visibleSourceText);
  }
  return { text: visibleText, sourceText: visibleText ? visibleSourceText : "" };
}

function composePreviewSuffixWithinLimits(params: PreviewSuffixParams): {
  text: string;
  visiblePrefix: string;
  visibleSuffix: string;
  prefixMaxChars: number;
  prefixMaxBytes: number;
} {
  const suffixPreview = renderPreviewSourcePrefixWithinLimits({
    sourceText: params.suffix,
    maxChars: params.maxChars,
    maxBytes: params.maxBytes,
  });
  const suffix = suffixPreview.text;
  const separator = params.prefix.trim() && suffix ? (params.separator ?? "\n\n") : "";
  const prefixMaxChars = params.maxChars - separator.length - suffix.length;
  const prefixMaxBytes =
    params.maxBytes - Buffer.byteLength(`${separator}${suffix}`, "utf8");
  const prefixPreview = renderPreviewSourcePrefixWithinLimits({
    sourceText: params.prefix,
    maxChars: prefixMaxChars,
    maxBytes: prefixMaxBytes,
  });
  return {
    text: prefixPreview.text ? `${prefixPreview.text}${separator}${suffix}` : suffix,
    visiblePrefix: prefixPreview.sourceText,
    visibleSuffix: suffixPreview.sourceText,
    prefixMaxChars,
    prefixMaxBytes,
  };
}

function appendPreviewSuffixWithinLimits(params: PreviewSuffixParams): string {
  return composePreviewSuffixWithinLimits(params).text;
}

function appendFailureNoticeToProgress(progress: string, notice: string): string {
  const trimmedProgress = progress.trimEnd();
  const lastLineStart = trimmedProgress.lastIndexOf("\n") + 1;
  const lastLine = trimmedProgress.slice(lastLineStart).trim();
  const trailingFastLine = /\bFast:\s*auto-(?:off|on)\b/i.test(lastLine) ? lastLine : "";
  return appendPreviewSuffixWithinLimits({
    prefix: trailingFastLine
      ? trimmedProgress.slice(0, lastLineStart).trimEnd()
      : trimmedProgress,
    suffix: trailingFastLine ? `${trailingFastLine}\n\n${notice}` : notice,
    maxChars: WECOM_STREAM_MAX_CHARS,
    maxBytes: WECOM_STREAM_MAX_BYTES,
  });
}

function isReplyNoVisibleOutputError(error: unknown, formattedMessage: string): boolean {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  return (
    name === "WeComReplyNoVisibleOutputError" ||
    formattedMessage.includes("WeCom Bot WS reply produced no visible output")
  );
}

function isOpenClawModelTimeoutError(error: unknown, formattedMessage: string): boolean {
  const message = `${formattedMessage} ${formatFallbackError(error)}`.toLowerCase();
  return (
    message.includes("llm idle timeout") ||
    message.includes("model idle timeout") ||
    message.includes("llm request timed out") ||
    message.includes("model did not produce a response before") ||
    message.includes("request timed out before a response was generated") ||
    message.includes("codex app-server turn idle timed out") ||
    message.includes("codex app-server attempt timed out") ||
    message.includes("turn_completion_idle_timeout") ||
    message.includes("turn_progress_idle_timeout") ||
    message.includes("turn_terminal_idle_timeout")
  );
}

function isPrepareTimeoutError(error: unknown, formattedMessage: string): boolean {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  return (
    name === "WeComPrepareTimeoutError" ||
    formattedMessage.includes("WeCom inbound session prepare timed out")
  );
}

const recentFinalDeliveriesByPeer = new Map<string, number>();
const pendingFinalRetryByPeer = new Map<
  string,
  Map<
    string,
    {
      cancel: () => void;
      shouldCancelForNewActivation: () => boolean;
    }
  >
>();
const replyOwnerCleanups = new Map<string, Set<() => void>>();
const OBSOLETE_FINAL_RETRY = Symbol("obsolete-final-retry");

export function registerBotWsReplyOwner(ownerId: string): void {
  const key = ownerId.trim();
  if (key && !replyOwnerCleanups.has(key)) {
    replyOwnerCleanups.set(key, new Set());
  }
}

export function retireBotWsReplyOwner(ownerId: string): void {
  const key = ownerId.trim();
  const cleanups = replyOwnerCleanups.get(key);
  replyOwnerCleanups.delete(key);
  for (const cleanup of cleanups ?? []) {
    try {
      cleanup();
    } catch (error) {
      console.warn(
        `[wecom-reply] owner-retire-failed ownerId=${key} error=${formatFallbackError(error)}`,
      );
    }
  }
}

function trackBotWsReplyOwner(ownerId: string | undefined, cleanup: () => void): () => void {
  const key = ownerId?.trim();
  if (!key) {
    return () => {};
  }
  const cleanups = replyOwnerCleanups.get(key);
  if (!cleanups) {
    cleanup();
    return () => {};
  }
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

function cancelPendingFinalRetryForNewActivation(
  peerKey: string,
  activationId: string,
): void {
  const pendingRetries = pendingFinalRetryByPeer.get(peerKey);
  if (!pendingRetries) {
    return;
  }
  for (const [pendingActivationId, pendingRetry] of pendingRetries) {
    if (
      pendingActivationId === activationId ||
      !pendingRetry.shouldCancelForNewActivation()
    ) {
      continue;
    }
    pendingRetries.delete(pendingActivationId);
    pendingRetry.cancel();
  }
  if (pendingRetries.size === 0) {
    pendingFinalRetryByPeer.delete(peerKey);
  }
}

function isInvalidReqIdError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const errcode = "errcode" in error ? Number(error.errcode) : undefined;
  const errmsg = "errmsg" in error ? String(error.errmsg ?? "") : "";
  return errcode === 846605 || errmsg.includes("invalid req_id");
}

function isExpiredStreamUpdateError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const errcode = "errcode" in error ? Number(error.errcode) : undefined;
  const errmsg = "errmsg" in error ? String(error.errmsg ?? "").toLowerCase() : "";
  return errcode === 846608 || errmsg.includes("stream message update expired");
}

/** SDK rejects with a plain Error whose message contains "ack timeout" when
 * the WeCom server does not acknowledge a reply within 5 s. The timed-out
 * frame is dequeued, but a late ACK can then resolve a newer frame that reused
 * the same req_id, so callback-stream sends must treat the req_id as terminal. */
function isAckTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ack timeout");
}

function isLocalReplyTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "WeComReplyTimeoutError";
}

function isAmbiguousActivePushDeliveryError(error: unknown): boolean {
  if (isAckTimeoutError(error) || isLocalReplyTimeoutError(error)) {
    return true;
  }
  const message = formatFallbackError(error).toLowerCase();
  return (
    /(?:socket|websocket|connection).*(?:closed|lost|reset)/.test(message) ||
    /(?:closed|lost|reset).*(?:socket|websocket|connection)/.test(message) ||
    (message.includes("reply") && message.includes("cancelled"))
  );
}

function isTerminalReplyError(error: unknown): boolean {
  return (
    isInvalidReqIdError(error) ||
    isExpiredStreamUpdateError(error) ||
    isAckTimeoutError(error) ||
    isLocalReplyTimeoutError(error)
  );
}

/** WeCom answered that this stream can never take another frame (unknown
 * req_id, or the ~6-minute stream window closed). Unlike a missing ACK — which
 * only means the gateway did not confirm in time — nothing can revive it, so it
 * is the only failure that may permanently retire the progress lane. */
function isDeadStreamError(error: unknown): boolean {
  return isInvalidReqIdError(error) || isExpiredStreamUpdateError(error);
}

function withReplySendTimeout<T>(
  promise: Promise<T>,
  operation: string,
  timeoutMs = WECOM_REPLY_SEND_TIMEOUT_MS,
  logContext?: string,
): Promise<T> {
  const startedAt = Date.now();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      const error = new Error(`WeCom ${operation} timed out after ${timeoutMs}ms`);
      error.name = "WeComReplyTimeoutError";
      reject(error);
    }, timeoutMs);
  });
  // Observe the original promise so that sends which settle after our local
  // timeout are still visible in logs. The SDK keeps timed-out frames queued
  // per req_id, so a "late settle" is evidence the frame was flushed to the
  // old stream after we already gave up (stale-bubble investigations).
  promise.then(
    () => {
      if (timedOut) {
        console.info(
          `[wecom-reply] late-settle-ok operation=${operation} elapsedMs=${Date.now() - startedAt}${logContext ? ` ${logContext}` : ""}`,
        );
      }
    },
    (error) => {
      if (timedOut) {
        console.info(
          `[wecom-reply] late-settle-error operation=${operation} elapsedMs=${Date.now() - startedAt}${logContext ? ` ${logContext}` : ""} error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  });
}

type NonBlockingReplyStreamClient = WSClient & {
  hasPendingReplyAck?: (frame: WsFrame<BaseMessage | EventMessage>) => boolean;
  replyStreamNonBlocking?: (
    frame: WsFrame<BaseMessage | EventMessage>,
    streamId: string,
    content: string,
    finish?: boolean,
  ) => Promise<unknown>;
};

function sendNonFinalStreamUpdate(params: {
  client: WSClient;
  frame: WsFrame<BaseMessage | EventMessage>;
  streamId: string;
  content: string;
}): Promise<unknown> {
  const client = params.client as NonBlockingReplyStreamClient;
  if (typeof client.replyStreamNonBlocking === "function") {
    return client.replyStreamNonBlocking(params.frame, params.streamId, params.content, false);
  }
  return params.client.replyStream(params.frame, params.streamId, params.content, false);
}

function hasPendingReplyAck(client: WSClient, frame: WsFrame<BaseMessage | EventMessage>): boolean {
  const candidate = client as NonBlockingReplyStreamClient;
  if (typeof candidate.hasPendingReplyAck !== "function") {
    return false;
  }
  try {
    return candidate.hasPendingReplyAck(frame);
  } catch {
    return false;
  }
}

async function waitForPendingReplyAckToClear(params: {
  client: WSClient;
  frame: WsFrame<BaseMessage | EventMessage>;
  timeoutMs?: number;
  hasLocalPendingReply?: () => boolean;
}): Promise<boolean> {
  const hasPending = () =>
    (params.hasLocalPendingReply?.() ?? false) || hasPendingReplyAck(params.client, params.frame);
  if (!hasPending()) {
    return true;
  }
  const deadline = Date.now() + (params.timeoutMs ?? WECOM_PENDING_ACK_GRACE_MS);
  while (hasPending()) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(WECOM_PENDING_ACK_POLL_MS, remainingMs)),
    );
  }
  return true;
}

function formatMediaFailure(mediaUrl: string, error?: string, rejectReason?: string): string {
  const reason = rejectReason || error || "unknown";
  return `媒体发送失败：${mediaUrl} (${reason})`;
}

function pruneRecentFinalDeliveries(now = Date.now()): void {
  for (const [key, expiresAt] of recentFinalDeliveriesByPeer) {
    if (expiresAt <= now) {
      recentFinalDeliveriesByPeer.delete(key);
    }
  }
}

function buildFinalDeliveryKey(params: {
  accountId: string;
  peerKind: "direct" | "group";
  peerId: string;
  reqId: string;
  text: string;
  mediaUrls: readonly string[];
}): string {
  const { accountId, peerKind, peerId, reqId, text, mediaUrls } = params;
  const digest = crypto
    .createHash("sha256")
    .update(text)
    .update("\0")
    .update(JSON.stringify(mediaUrls))
    .digest("hex");
  return [
    accountId,
    peerKind,
    peerId,
    reqId,
    digest,
  ].join(":");
}

function shouldSkipRecentPeerFinal(key: string): boolean {
  const now = Date.now();
  pruneRecentFinalDeliveries(now);
  if ((recentFinalDeliveriesByPeer.get(key) ?? 0) > now) {
    return true;
  }
  recentFinalDeliveriesByPeer.set(key, now + B2_PEER_FINAL_DEDUP_TTL_MS);
  return false;
}

function normalizePeerKey(peerId: string): string {
  return peerId.trim().toLowerCase();
}

function mergeReplyText(previous: string, incoming: string): string {
  const base = previous.trim();
  const next = incoming.trim();
  if (!base) return next;
  if (!next) return base;
  if (base === next || base.startsWith(next)) return base;
  if (next.startsWith(base)) return next;

  const maxOverlap = Math.min(base.length, next.length);
  for (let overlap = maxOverlap; overlap >= 16; overlap -= 1) {
    if (base.endsWith(next.slice(0, overlap))) {
      return `${base}${next.slice(overlap)}`;
    }
  }
  return `${base}\n${next}`;
}

function mergeFinalReplyText(previous: string, incoming: string): string {
  const base = previous.trim();
  const next = incoming.trim();
  if (!base || !next) {
    return mergeReplyText(base, next);
  }

  const normalizedNext = normalizeDedupText(next);
  if (
    normalizedNext.length >= LONG_FINAL_DEDUP_MIN_SEGMENT_CHARS &&
    normalizeDedupText(base).endsWith(normalizedNext)
  ) {
    return base;
  }

  return mergeReplyText(base, next);
}

function normalizeDedupText(value: string): string {
  return value
    .replace(/【(?:消息过长，分段发送：)?第\d+\/\d+段】/g, "")
    .replace(/\s+/g, "")
    .replace(/[，。；：、,.。;:]/g, "")
    .toLowerCase();
}

function dedupeLongFinalText(text: string, options: { previewFrozen: boolean }): string {
  if (!options.previewFrozen && text.length < LONG_FINAL_DEDUP_MIN_CHARS) {
    return text;
  }

  const repeatedTail = findRepeatedHeadingTail(text);
  if (!repeatedTail) {
    return text;
  }
  return `${text.slice(0, repeatedTail.start)}${text.slice(repeatedTail.end)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findRepeatedHeadingTail(text: string): { start: number; end: number } | undefined {
  const lines = text.split("\n");
  const headings = new Map<string, Array<{ raw: string; start: number }>>();
  let offset = 0;

  for (const raw of lines) {
    const normalized = normalizeHeadingLine(raw);
    if (normalized) {
      const entries = headings.get(normalized) ?? [];
      entries.push({ raw, start: offset });
      headings.set(normalized, entries);
    }
    offset += raw.length + 1;
  }

  for (const entries of headings.values()) {
    if (entries.length < 2) {
      continue;
    }
    const first = entries[0];
    const second = entries[1];
    if (!first || !second || second.start < Math.floor(text.length * 0.25)) {
      continue;
    }
    const prior = text.slice(first.start, second.start);
    const tail = text.slice(second.start);
    if (
      tail.length < LONG_FINAL_DEDUP_MIN_SEGMENT_CHARS ||
      !looksLikeStructuredRepeatedTail(tail) ||
      !hasStructuredOverlapBeforeRepeatedTail(prior, tail)
    ) {
      continue;
    }
    const duplicateTailEnd = findRepeatedStructuredTailDuplicateEnd(prior, tail);
    if (duplicateTailEnd > 0) {
      return { start: second.start, end: second.start + duplicateTailEnd };
    }
  }

  return undefined;
}

function findRepeatedStructuredTailDuplicateEnd(prior: string, tail: string): number {
  const comparableLines = (text: string) => {
    let offset = 0;
    return text.split("\n").flatMap((raw, index, lines) => {
      offset += raw.length + (index < lines.length - 1 ? 1 : 0);
      const exact = raw.trim();
      return exact.length >= 2 ? [{ exact, end: offset }] : [];
    });
  };
  const priorLines = comparableLines(prior);
  const tailLines = comparableLines(tail);
  if (tailLines.length < STRUCTURED_TAIL_MIN_DUPLICATE_LINES) {
    return 0;
  }

  let bestEnd = 0;
  for (let start = 0; start < priorLines.length; start += 1) {
    if (priorLines[start]?.exact !== tailLines[0]?.exact) {
      continue;
    }
    let matched = 0;
    while (
      start + matched < priorLines.length &&
      matched < tailLines.length &&
      priorLines[start + matched]?.exact === tailLines[matched]?.exact
    ) {
      matched += 1;
    }
    if (matched >= STRUCTURED_TAIL_MIN_DUPLICATE_LINES) {
      bestEnd = Math.max(bestEnd, tailLines[matched - 1]?.end ?? 0);
    }
  }
  return bestEnd;
}

function normalizeHeadingLine(line: string): string {
  const trimmed = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/, "")
    .trim();
  if (trimmed.length < 12 || trimmed.length > 80) {
    return "";
  }
  if (/^\|.*\|$/.test(trimmed) || /^[·*-]/.test(trimmed)) {
    return "";
  }
  const normalized = normalizeDedupText(trimmed.replace(/[（(]\d{4}[-/]\d{1,2}[-/]\d{1,2}[^）)]*[）)]/g, ""));
  return normalized.length >= 8 ? normalized : "";
}

function looksLikeStructuredRepeatedTail(tail: string): boolean {
  return collectStructuredDedupeMarkers(tail).size >= 2;
}

function hasStructuredOverlapBeforeRepeatedTail(prior: string, tail: string): boolean {
  const priorMarkers = collectStructuredDedupeMarkers(prior);
  if (priorMarkers.size < 2) {
    return false;
  }
  let matches = 0;
  for (const marker of collectStructuredDedupeMarkers(tail)) {
    if (priorMarkers.has(marker)) {
      matches += 1;
      if (matches >= 2) {
        return true;
      }
    }
  }
  return false;
}

function collectStructuredDedupeMarkers(text: string): Set<string> {
  const markers = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim().replace(/^#{1,6}\s+/, "");
    if (!trimmed) {
      continue;
    }

    const heading = trimmed.match(/^[一二三四五六七八九十]+[、.．]\s*(.{2,80})$/);
    if (heading) {
      const normalized = normalizeDedupText(heading[1] ?? "");
      if (normalized.length >= 2) {
        markers.add(`h:${normalized}`);
      }
      continue;
    }

    const next = (lines[i + 1] ?? "").trim();
    if (/^\|.*\|$/.test(trimmed) && /^\|[-:\s|]+\|$/.test(next)) {
      const normalized = normalizeDedupText(trimmed);
      if (normalized.length >= 4) {
        markers.add(`t:${normalized}`);
      }
    }
  }
  return markers;
}

function formatFallbackError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const errcode = "errcode" in error ? String(error.errcode) : "";
    const errmsg = "errmsg" in error ? String(error.errmsg ?? "") : "";
    const combined = `${errcode} ${errmsg}`.trim();
    if (combined) return combined;
  }
  return String(error);
}

function formatElapsedDuration(elapsedMs: number): string {
  // A zero-duration measurement is not useful to the user; keep a one-second
  // minimum while retaining the existing whole-second display precision.
  const elapsedSeconds = Math.max(1, Math.floor(Math.max(0, elapsedMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const remainingSeconds = elapsedSeconds % 60;
  return `${elapsedMinutes}m${String(remainingSeconds).padStart(2, "0")}s`;
}

function formatElapsedStatus(elapsedMs: number): string {
  return `${LONG_TASK_STATUS_PREFIX}${formatElapsedDuration(elapsedMs)}】`;
}

function appendFinalCompletionMarker(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) {
    return FINAL_COMPLETION_MARKER;
  }
  if (trimmed.endsWith(FINAL_COMPLETION_MARKER)) {
    return trimmed;
  }
  return `${trimmed}\n\n${FINAL_COMPLETION_MARKER}`;
}

function escapeLiteralThinkTags(text: string): string {
  return text.replace(THINK_TAG_RE, (tag) =>
    tag.startsWith("</") ? "&lt;/think&gt;" : "&lt;think&gt;",
  );
}

function chunkWeComMarkdownWireV2(
  markdown: string,
  maxChars: number,
  maxBytes: number,
  appendCompletionMarker = false,
): string[] {
  const wireText = escapeLiteralThinkTags(toWeComMarkdownV2(markdown, null));
  if (!appendCompletionMarker) {
    return chunkFormattedWeComMarkdownV2(wireText, maxChars, maxBytes);
  }

  const markerSuffix = `\n\n${FINAL_COMPLETION_MARKER}`;
  const trimmedWireText = wireText.trimEnd();
  const bodyWireText = trimmedWireText.endsWith(FINAL_COMPLETION_MARKER)
    ? trimmedWireText.slice(0, -FINAL_COMPLETION_MARKER.length).trimEnd()
    : wireText;
  const chunks = chunkFormattedWeComMarkdownV2(
    bodyWireText,
    maxChars - markerSuffix.length,
    maxBytes - Buffer.byteLength(markerSuffix, "utf8"),
  );
  const out = [...chunks];
  const lastIndex = out.length - 1;
  out[lastIndex] = appendFinalCompletionMarker(out[lastIndex] ?? "");
  return out;
}

function collectMarkdownCodeRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const fenceRe = /(^|\n)(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n\2(?=\n|$)|$)|$)/g;
  for (const match of text.matchAll(fenceRe)) {
    ranges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  const inlineCodeRe = /`[^`\n]*`/g;
  for (const match of text.matchAll(inlineCodeRe)) {
    const start = match.index ?? 0;
    if (!isInsideProtectedRange(start, ranges)) {
      ranges.push({ start, end: start + match[0].length });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function isInsideProtectedRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function findThinkTagOutsideCode(params: {
  text: string;
  tagRe: RegExp;
  from: number;
  protectedRanges: Array<{ start: number; end: number }>;
}): { start: number; end: number } | undefined {
  const tagRe = new RegExp(params.tagRe.source, params.tagRe.flags);
  tagRe.lastIndex = params.from;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(params.text))) {
    if (!isInsideProtectedRange(match.index, params.protectedRanges)) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  return undefined;
}

function extractInlineThinkBlocks(text: string): { bodyText: string; thinkingText: string } {
  if (!THINK_TAG_RE.test(text)) {
    return { bodyText: text, thinkingText: "" };
  }
  THINK_TAG_RE.lastIndex = 0;
  const protectedRanges = collectMarkdownCodeRanges(text);
  const bodyParts: string[] = [];
  const thinkingParts: string[] = [];
  let cursor = 0;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const openTag = findThinkTagOutsideCode({
      text,
      tagRe: OPEN_THINK_TAG_RE,
      from: searchFrom,
      protectedRanges,
    });
    if (!openTag) {
      break;
    }
    const closeTag = findThinkTagOutsideCode({
      text,
      tagRe: CLOSE_THINK_TAG_RE,
      from: openTag.end,
      protectedRanges,
    });
    if (!closeTag) {
      break;
    }
    bodyParts.push(text.slice(cursor, openTag.start));
    const thinkingText = text.slice(openTag.end, closeTag.start).trim();
    if (thinkingText) {
      thinkingParts.push(thinkingText);
    }
    cursor = closeTag.end;
    searchFrom = closeTag.end;
  }

  bodyParts.push(text.slice(cursor));
  return {
    bodyText: bodyParts.join("").trim(),
    thinkingText: thinkingParts.join("\n\n").trim(),
  };
}

function isLikelyLongFinalText(text: string): boolean {
  return text.length > WECOM_STREAM_FINAL_MAX_CHARS || Buffer.byteLength(text, "utf8") > WECOM_STREAM_MAX_BYTES;
}

function shouldAppendStreamCompletionMarker(params: {
  finalText: string;
  previewFrozen: boolean;
  reasoningOnly: boolean;
}): boolean {
  return (
    params.reasoningOnly ||
    params.previewFrozen ||
    isLikelyLongFinalText(params.finalText)
  );
}

function escapeThinkBlockText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/<[^>\n]*>/g, "")
    .trim();
}

function stripDanglingThinkMarkup(text: string): string {
  return text
    .replace(/(?:<!--(?:(?!-->)[\s\S])*|<!-?|<--|<)$/, "")
    .trimEnd();
}

function trimToUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let out = "";
  for (const ch of value) {
    if (Buffer.byteLength(out + ch, "utf8") > maxBytes) {
      break;
    }
    out += ch;
  }
  return out;
}

function sliceUtf16SafePrefix(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) {
    return value;
  }
  let end = Math.max(0, maxCodeUnits);
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return value.slice(0, end);
}

function renderThinkContent(
  text: string,
  maxBytes = THINKING_BLOCK_MAX_BYTES,
  maxChars = THINKING_BLOCK_MAX_CHARS,
): string {
  return stripDanglingThinkMarkup(
    trimToUtf8Bytes(
      sliceUtf16SafePrefix(
        escapeThinkBlockText(text || "progress"),
        Math.min(THINKING_BLOCK_MAX_CHARS, Math.max(0, maxChars)),
      ),
      Math.min(THINKING_BLOCK_MAX_BYTES, maxBytes),
    ).trim(),
  );
}

function renderInlineThinkBlock(
  text: string,
  maxBytes = THINKING_BLOCK_MAX_BYTES,
  maxChars = THINKING_BLOCK_MAX_CHARS,
): string {
  if (!text.trim()) {
    return "";
  }
  const escaped = renderThinkContent(text, maxBytes, maxChars);
  return escaped ? `<think>${escaped}</think>` : "";
}

function resolveThinkingAwareBodyLimits(thinkingText: string): {
  maxChars: number;
  maxBytes: number;
} {
  const inlineBlock = renderInlineThinkBlock(thinkingText);
  if (!inlineBlock) {
    return { maxChars: WECOM_STREAM_MAX_CHARS, maxBytes: WECOM_STREAM_MAX_BYTES };
  }
  const prefix = `${inlineBlock}\n`;
  return {
    maxChars: Math.max(100, WECOM_STREAM_MAX_CHARS - prefix.length),
    maxBytes: Math.max(512, WECOM_STREAM_MAX_BYTES - Buffer.byteLength(prefix, "utf8")),
  };
}

// Global registry to track active keepalives by account/conversation scope.
interface ActiveKeepalive {
  reqId: string;
  stop: () => void;
}
const activeKeepalivesByScope = new Map<string, Set<ActiveKeepalive>>();

export function __resetBotWsReplyTestState(): void {
  recentFinalDeliveriesByPeer.clear();
  pendingFinalRetryByPeer.clear();
  activeKeepalivesByScope.clear();
  replyOwnerCleanups.clear();
}

export function createBotWsReplyHandle(params: {
  client: WSClient;
  frame: WsFrame<BaseMessage | EventMessage>;
  accountId: string;
  inboundKind: string;
  placeholderContent?: string;
  autoSendPlaceholder?: boolean;
  forceActivePush?: boolean;
  isCallbackStreamCurrent?: () => boolean;
  callbackStreamClaimId?: string;
  deferActivation?: boolean;
  runtimeOwnerId?: string;
  onDeliver?: () => void;
  onFail?: (error: unknown) => void;
}): ReplyHandle {
  let streamId: string | undefined;
  let accumulatedText = "";
  let accumulatedThinkingText = "";
  let latestTransientProgressText = "";
  const transientProgressTextByKind = new Map<string, string>();
  let deferredMediaUrls: string[] = [];
  // Two independent lanes only: the current narration step and OpenClaw's Fast
  // mode line. Both are single current values, so composing is a plain join.
  const rememberTransientProgress = (kind: string, text: string): string => {
    transientProgressTextByKind.set(kind, text);
    latestTransientProgressText = [...transientProgressTextByKind.values()]
      .filter(Boolean)
      .join("\n\n");
    return latestTransientProgressText;
  };
  const resolveStreamId = () => {
    streamId ||= generateReqId("stream");
    return streamId;
  };

  const placeholderText = params.placeholderContent?.trim() || "⏳ 正在思考中...\n\n";
  let streamSettled = false;
  let placeholderInFlight = false;
  let placeholderKeepalive: ReturnType<typeof setTimeout> | undefined;
  let previewFreezeTimeout: ReturnType<typeof setTimeout> | undefined;
  let previewStatusInterval: ReturnType<typeof setInterval> | undefined;
  let previewStatusInFlight = false;
  let previewInFlightCount = 0;
  type PreviewDeliveryMetadata = {
    bodySourceText?: string;
    showsVisibleBody?: boolean;
    transientProgressText?: string;
  };
  type PendingPreview = {
    text: string;
    bodySourceText?: PreviewDeliveryMetadata["bodySourceText"];
    showsVisibleBody?: PreviewDeliveryMetadata["showsVisibleBody"];
    transientProgressText?: PreviewDeliveryMetadata["transientProgressText"];
    deadline: number;
    retryCount: number;
  };
  let pendingPreview: PendingPreview | undefined;
  let pendingPreviewPollTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingPreviewFlushInFlight = false;
  let runtimeRetired = false;
  let dispatchSettled = false;
  let unregisterRuntimeCleanup: (() => void) | undefined;
  const transportRetireListeners = new Set<() => void>();

  function releaseRuntimeCleanup(): void {
    unregisterRuntimeCleanup?.();
    unregisterRuntimeCleanup = undefined;
  }

  // Extract peerId for clustering handles
  const body = params.frame.body as any;
  const peerId = String(
    (body?.chattype === "group" ? body?.chatid || body?.from?.userid : body?.from?.userid) ||
      "unknown",
  );
  const peerKeyId = normalizePeerKey(peerId);
  const peerKind: "direct" | "group" = body?.chattype === "group" ? "group" : "direct";
  const reqId = params.frame.headers.req_id || "unknown";
  const finalDeliveryReqId = params.callbackStreamClaimId
    ? `${reqId}:${params.callbackStreamClaimId}`
    : reqId;
  const replyPeerKey = JSON.stringify([params.accountId, peerKind, peerKeyId]);
  const activationId = crypto.randomUUID();
  let activated = false;
  let placeholderStarted = false;

  const isEvent =
    params.inboundKind === "welcome" ||
    params.inboundKind === "event" ||
    params.inboundKind === "template-card-event";

  const sendLogContext = `account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId}`;
  const withHandleSendTimeout = <T>(
    promise: Promise<T>,
    operation: string,
    timeoutMs?: number,
  ): Promise<T> => withReplySendTimeout(promise, operation, timeoutMs, sendLogContext);

  const pausePlaceholderHeartbeat = () => {
    if (placeholderKeepalive) {
      clearTimeout(placeholderKeepalive);
      placeholderKeepalive = undefined;
    }
  };

  const stopPlaceholderKeepalive = () => {
    pausePlaceholderHeartbeat();

    // Remove from registry
    const keepalives = activeKeepalivesByScope.get(replyPeerKey);
    if (keepalives) {
      for (const ka of keepalives) {
        if (ka.reqId === reqId) {
          keepalives.delete(ka);
        }
      }
      if (keepalives.size === 0) {
        activeKeepalivesByScope.delete(replyPeerKey);
      }
    }
  };

  const stopPreviewStatusInterval = () => {
    if (previewStatusInterval) {
      clearInterval(previewStatusInterval);
      previewStatusInterval = undefined;
    }
  };

  const stopPreviewFreezeTimeout = () => {
    if (previewFreezeTimeout) {
      clearTimeout(previewFreezeTimeout);
      previewFreezeTimeout = undefined;
    }
  };

  const clearPendingPreview = () => {
    if (pendingPreviewPollTimer) {
      clearTimeout(pendingPreviewPollTimer);
      pendingPreviewPollTimer = undefined;
    }
    pendingPreview = undefined;
  };

  const settleStream = () => {
    if (streamSettled) return;
    streamSettled = true;
    stopPlaceholderKeepalive();
    stopPreviewFreezeTimeout();
    stopPreviewStatusInterval();
    cancelPreviewExpiredNotice();
    clearPendingPreview();
  };

  const renderLongTaskHeartbeat = (elapsedMs: number): string => {
    const thinkingBlock = renderInlineThinkBlock(accumulatedThinkingText);
    const bodyLimits = resolveThinkingAwareBodyLimits(accumulatedThinkingText);
    const statusSuffix = [latestTransientProgressText, formatElapsedStatus(elapsedMs)]
      .filter(Boolean)
      .join("\n\n");
    const body = composePreviewSuffixWithinLimits({
      prefix: accumulatedText,
      suffix: statusSuffix,
      maxChars: bodyLimits.maxChars,
      maxBytes: bodyLimits.maxBytes,
    }).text;
    return thinkingBlock ? `${thinkingBlock}\n${body}` : body;
  };

  /** Returns true when a frame was actually put on the wire. A false result
   *  means the lane was momentarily blocked, so the caller retries shortly
   *  rather than re-arming on a due time that is already in the past. */
  const sendPlaceholder = (): boolean => {
    if (forceActivePushRequired()) {
      maybeSendPreviewExpiredNotice(true);
      return false;
    }
    if (
      runtimeRetired ||
      !placeholderStarted ||
      streamSettled ||
      placeholderInFlight ||
      streamUpdateUnreliable ||
      supersededByNewInbound ||
      isEvent
    )
      return false;
    const elapsedMs = Date.now() - handleStartedAt;
    // Before the long-task gate, real process text owns the bubble. Once the
    // gate is reached, reasoning/preamble-only turns still need the same timed
    // status; body previews use their dedicated frozen-status lane.
    if (lastPreviewText && (elapsedMs < LONG_TASK_STATUS_AFTER_MS || previewFrozen)) {
      return false;
    }
    // Re-check the shared clock at paint time, not just at schedule time: the
    // slot may have been spent by a real progress frame while this timer sat
    // in the queue, and repainting anyway is what produced a status frame a
    // second or two behind an unrelated update.
    if (elapsedMs >= LONG_TASK_STATUS_AFTER_MS && !isLongTaskStatusDue()) {
      return false;
    }
    if (
      streamId !== undefined &&
      (previewInFlightCount > 0 ||
        pendingPreviewFlushInFlight ||
        Boolean(pendingPreview) ||
        hasPendingReplyAck(params.client, params.frame))
    ) {
      return false;
    }
    placeholderInFlight = true;
    // A turn that produces nothing (all tool work, and OpenClaw's reasoning
    // stream is off by default) has no other feedback: repeating one static
    // line taught the user nothing, so show the clock instead.
    const showsLongTaskStatus = elapsedMs >= LONG_TASK_STATUS_AFTER_MS;
    const heartbeatText = showsLongTaskStatus
      ? renderLongTaskHeartbeat(elapsedMs)
      : placeholderText;
    const releaseLongTaskStatusSlot = showsLongTaskStatus
      ? claimLongTaskStatusSlot()
      : undefined;
    withHandleSendTimeout(
      params.client.replyStream(params.frame, resolveStreamId(), heartbeatText, false),
      "stream placeholder",
      )
      .catch((error) => {
        if (isLocalReplyTimeoutError(error)) {
          console.warn(
            `[wecom-preview] placeholder-timeout account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
          );
          if (Date.now() - handleStartedAt >= LONG_TASK_STATUS_AFTER_MS) {
            streamAckUnreliable = true;
            stopPlaceholderKeepalive();
            maybeSendPreviewExpiredNotice(true);
            return;
          }
          scheduleHeartbeat(PLACEHOLDER_RETRY_MS);
          return;
        }
        if (!isDeadStreamError(error)) {
          // A missing ACK is not a dead stream: the keepalive re-sends, and the
          // first progress update takes the bubble over. Retiring the stream
          // here left long tasks stuck on the placeholder for their whole run.
          console.warn(
            `[wecom-preview] placeholder-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
          );
          if (isAckTimeoutError(error)) {
            streamAckUnreliable = true;
            params.onFail?.(error);
          }
          if (Date.now() - handleStartedAt >= LONG_TASK_STATUS_AFTER_MS) {
            stopPlaceholderKeepalive();
            maybeSendPreviewExpiredNotice(true);
            return;
          }
          scheduleHeartbeat(PLACEHOLDER_RETRY_MS);
          return;
        }
        // The bubble is unrepaintable, but the turn is still running. Settling
        // the whole handle here cancelled the deferred background push too, so
        // a silent long task stayed silent; retire the lane and hand over.
        // WeCom refused the frame, so this slot was never shown — give it back
        // and let the push lane use it right away.
        releaseLongTaskStatusSlot?.();
        streamUpdateUnreliable = true;
        stopPlaceholderKeepalive();
        maybeSendPreviewExpiredNotice(true);
        params.onFail?.(error);
      })
      .finally(() => {
        placeholderInFlight = false;
        if (supersededByNewInbound && !streamUpdateUnreliable) {
          closeSupersededPlaceholder();
        }
      });
    return true;
  };

  const notifyPeerActive = () => {
    if (!activated || supersededByNewInbound) {
      return;
    }
    // A genuine reply or reasoning is happening on THIS handle.
    // It means the core SDK has chosen this handle to deliver the response.
    // We can safely terminate other orphaned keepalives in this conversation scope.
    const keepalives = activeKeepalivesByScope.get(replyPeerKey);
    if (keepalives) {
      for (const ka of keepalives) {
        if (ka.reqId !== reqId) {
          ka.stop();
        }
      }
    }
  };

  const mergeDeferredMediaUrls = (urls: string[]): string[] => {
    if (urls.length === 0) {
      return deferredMediaUrls;
    }
    const merged = [...deferredMediaUrls];
    for (const url of urls) {
      if (!merged.includes(url)) {
        merged.push(url);
      }
    }
    deferredMediaUrls = merged;
    return deferredMediaUrls;
  };

  let finalDelivered = false;
  let finalDeliveryKey = "";
  let supersededByNewInbound = false;
  let suppressSupersededFinalPush = false;
  let supersededNoticeSent = false;
  let supersededNoticeText = B3_SUPERSEDED_NOTICE_TEXT;
  let supersededAt: number | undefined;
  let visibleReplyStarted = false;
  // A reused req_id addresses the predecessor's existing bubble and SDK ACK
  // queue. Once this handle loses its exact claim, latch the callback lane off:
  // an old handle must never become current again after a successor claims it.
  let callbackOwnershipLost = params.forceActivePush === true;
  let callbackOwnershipLossLogged = false;
  let streamUpdateUnreliable = callbackOwnershipLost;
  // A frame this req_id never got an ACK for. The stream itself stays writable
  // — progress updates keep painting — but the SDK matches ACKs by req_id only,
  // so a late ACK can resolve the NEXT frame's promise. Anything whose delivery
  // must be trusted (final, stream close, supersede notice) therefore leaves
  // this stream for the active-push path.
  let streamAckUnreliable = false;
  const refreshCallbackStreamOwnership = (): boolean => {
    if (callbackOwnershipLost) {
      return false;
    }
    if (params.isCallbackStreamCurrent?.() !== false) {
      return true;
    }
    callbackOwnershipLost = true;
    streamUpdateUnreliable = true;
    clearPendingPreview();
    stopPlaceholderKeepalive();
    stopPreviewFreezeTimeout();
    stopPreviewStatusInterval();
    if (!callbackOwnershipLossLogged) {
      callbackOwnershipLossLogged = true;
      console.warn(
        `[wecom-ws] callback-stream-ownership-lost account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} route=active-push`,
      );
    }
    return false;
  };
  const forceActivePushRequired = (): boolean => !refreshCallbackStreamOwnership();
  const streamDeliveryUntrusted = (): boolean => {
    refreshCallbackStreamOwnership();
    return streamUpdateUnreliable || streamAckUnreliable;
  };
  // Start the progress clock with the task, not with the first visible block.
  // Tool/reasoning work can precede that block by several minutes.
  const handleStartedAt = Date.now();
  let previewFrozen = false;
  let previewFrozenSourceText = "";
  let previewFrozenDeliveredSourceText = "";
  let previewFrozenText = "";
  let lastPreviewText = "";
  let lastDeliveredBodySourceText = "";
  let lastDeliveredTransientProgressText = "";
  let lastPreviewUpdateAt = 0;
  // The status line has three possible painters — the bubble heartbeat, the
  // frozen-preview refresh and the background push — and they used to keep
  // three independent timers, each re-armed by whatever unrelated event
  // happened to touch it (a narration frame, an external push, a missing ACK).
  // That is why the observed spacing wandered between 5 s and 22 s and why the
  // same status could arrive twice through two channels seconds apart. There
  // is now ONE clock on an absolute grid anchored to the turn start: every
  // lane asks it whether a repaint is due, and reports back when it painted.
  let longTaskStatusPaintedAt = 0;
  let previewExpiredNoticeInFlight = false;
  let previewExpiredNoticeCancelled = false;
  let previewExpiredNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  // Only a cadence that has actually started may be deferred: arming one from
  // external activity alone would push notices for a perfectly healthy stream.
  let previewExpiredNoticeStarted = false;
  let previewExpiredNoticeAllowUnfrozen = false;
  let previewWatchdogExpired = false;
  let failNoticeSent = false;
  let finalPushRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let finalPushRetryCount = 0;
  let finalPushProgress:
    | {
        forText: string;
        withMarker: boolean;
        maxChars: number;
        maxBytes: number;
        delivered: number;
      }
    | undefined;

  const markFinalDelivered = (key: string, options: { peerDedup: boolean }): boolean => {
    if (finalDelivered) {
      if (key === finalDeliveryKey) {
        console.info(
          `[wecom-b3] final-skip already-delivered account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
        );
      } else {
        // A SECOND final with different content on one handle. The dedup is
        // built for retries of the same answer, so this drops a distinct
        // message; no WeCom case has been observed, and this line is what would
        // prove one.
        console.warn(
          `[wecom-b3] final-skip second-distinct account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
        );
      }
      return false;
    }
    if (options.peerDedup && shouldSkipRecentPeerFinal(key)) {
      finalDelivered = true;
      finalDeliveryKey = key;
      console.info(
        `[wecom-b3] final-skip recent-peer account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
      );
      return false;
    }
    finalDelivered = true;
    finalDeliveryKey = key;
    return true;
  };

  const rollbackFinalDelivered = (key: string, options: { peerDedup: boolean }): void => {
    if (finalDeliveryKey !== key) {
      return;
    }
    finalDelivered = false;
    finalDeliveryKey = "";
    if (options.peerDedup) {
      recentFinalDeliveriesByPeer.delete(key);
    }
  };

  let pendingFinalRetryClaim:
    | { deliveryKey: string; peerDedup: boolean; preserve: boolean }
    | undefined;
  let obsoleteFinalRetry = false;
  const maybeReleaseRuntimeCleanup = (): void => {
    if (dispatchSettled && !finalPushRetryTimer && !pendingFinalRetryClaim) {
      releaseRuntimeCleanup();
    }
  };
  const isCurrentReplyActivation = (): boolean => !obsoleteFinalRetry;
  const finishPendingFinalRetry = (rollbackClaim: boolean): void => {
    const pendingRetries = pendingFinalRetryByPeer.get(replyPeerKey);
    pendingRetries?.delete(activationId);
    if (pendingRetries?.size === 0) {
      pendingFinalRetryByPeer.delete(replyPeerKey);
    }
    if (finalPushRetryTimer) {
      clearTimeout(finalPushRetryTimer);
      finalPushRetryTimer = undefined;
    }
    if (rollbackClaim && pendingFinalRetryClaim && !pendingFinalRetryClaim.preserve) {
      rollbackFinalDelivered(pendingFinalRetryClaim.deliveryKey, {
        peerDedup: pendingFinalRetryClaim.peerDedup,
      });
    }
    pendingFinalRetryClaim = undefined;
    maybeReleaseRuntimeCleanup();
  };

  const retireRuntimeWork = (): void => {
    if (runtimeRetired) {
      return;
    }
    runtimeRetired = true;
    obsoleteFinalRetry = true;
    finishPendingFinalRetry(true);
    settleStream();
    for (const listener of transportRetireListeners) {
      try {
        listener();
      } catch (error) {
        console.warn(
          `[wecom-reply] transport-retire-listener-failed ownerId=${params.runtimeOwnerId ?? "n/a"} error=${formatFallbackError(error)}`,
        );
      }
    }
    transportRetireListeners.clear();
  };

  const ensureRuntimeCleanup = (): boolean => {
    if (runtimeRetired) {
      return false;
    }
    if (!unregisterRuntimeCleanup && params.runtimeOwnerId?.trim()) {
      unregisterRuntimeCleanup = trackBotWsReplyOwner(
        params.runtimeOwnerId,
        retireRuntimeWork,
      );
    }
    return !runtimeRetired;
  };

  // Chunk-delivery progress for the final's fallback/retry pushes. Chunking
  // is deterministic for the same (text, marker) pair, so a retry can skip
  // chunks that already reached the user instead of re-sending the whole
  // answer from chunk 0 (which would duplicate delivered segments).
  const resolveFinalPushProgress = (
    text: string,
    withMarker: boolean,
    chunkOptions?: { maxChars?: number; maxBytes?: number },
  ): { delivered: number } => {
    const maxChars = chunkOptions?.maxChars ?? 0;
    const maxBytes = chunkOptions?.maxBytes ?? 0;
    if (
      !finalPushProgress ||
      finalPushProgress.forText !== text ||
      finalPushProgress.withMarker !== withMarker ||
      finalPushProgress.maxChars !== maxChars ||
      finalPushProgress.maxBytes !== maxBytes
    ) {
      finalPushProgress = { forText: text, withMarker, maxChars, maxBytes, delivered: 0 };
    }
    return finalPushProgress;
  };

  const sendMarkdownChunksViaActivePush = async (
    textToSend: string,
    options: {
      reason:
        | "superseded-final"
        | "stream-fallback"
        | "stream-remainder"
        | "final-retry"
        | "preview-expired"
        | "forced-progress"
        | "fail-notice";
      appendCompletionMarker?: boolean;
      progress?: { delivered: number };
      maxChars?: number;
      maxBytes?: number;
      isObsolete?: () => boolean;
    },
  ): Promise<void> => {
    const throwIfObsolete = (): void => {
      if (runtimeRetired || options.isObsolete?.()) {
        throw OBSOLETE_FINAL_RETRY;
      }
    };
    throwIfObsolete();
    const markdownChunks = chunkWeComMarkdownWireV2(
      textToSend,
      options.maxChars ?? WECOM_STREAM_MAX_CHARS,
      options.maxBytes ?? WECOM_STREAM_MAX_BYTES,
      options.appendCompletionMarker === true,
    );
    const progress = options.progress;
    const firstIndex = progress ? Math.min(progress.delivered, markdownChunks.length) : 0;
    if (firstIndex >= markdownChunks.length) {
      return;
    }
    const markChunkDelivered = (index: number): void => {
      if (progress && index + 1 > progress.delivered) {
        progress.delivered = index + 1;
      }
      if (
        options.reason === "superseded-final" ||
        options.reason === "stream-fallback" ||
        options.reason === "stream-remainder" ||
        options.reason === "final-retry"
      ) {
        visibleReplyStarted = true;
      }
    };
    const sendViaClient = async (): Promise<void> => {
      for (let i = firstIndex; i < markdownChunks.length; i += 1) {
        throwIfObsolete();
        const chunk = markdownChunks[i] ?? "";
        console.info(
          `[wecom-b3] client-push account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} reason=${options.reason} chunk=${i + 1}/${markdownChunks.length}`,
        );
        await withHandleSendTimeout(
          params.client.sendMessage(peerId, {
            msgtype: "markdown",
            markdown: { content: chunk },
          }),
          "client markdown push",
        );
        markChunkDelivered(i);
        throwIfObsolete();
        if (i < markdownChunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
    };

    const pushHandle = getBotWsPushHandle(params.accountId);
    const pushHandleOwnedByRuntime =
      !params.runtimeOwnerId || pushHandle?.ownerId === params.runtimeOwnerId;
    if (!pushHandleOwnedByRuntime || !pushHandle?.isConnected?.()) {
      await sendViaClient();
      return;
    }

    for (let i = firstIndex; i < markdownChunks.length; i += 1) {
      try {
        throwIfObsolete();
        const chunk = markdownChunks[i] ?? "";
        console.info(
          `[wecom-b3] active-push account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} reason=${options.reason} chunk=${i + 1}/${markdownChunks.length}`,
        );
        await withHandleSendTimeout(pushHandle.sendMarkdown(peerId, chunk), "active markdown push");
        markChunkDelivered(i);
        throwIfObsolete();
        if (i < markdownChunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      } catch (error) {
        if (error === OBSOLETE_FINAL_RETRY) {
          throw error;
        }
        console.warn(
          `[wecom-b3] active-push-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} reason=${options.reason} chunk=${i + 1}/${markdownChunks.length} error=${formatFallbackError(error)}`,
        );
        streamUpdateUnreliable = true;
        throw error;
      }
    }
  };

  interface FinalPushRetryRequest {
    text: string;
    deliveryKey: string;
    peerDedup: boolean;
    appendCompletionMarker: boolean;
    alreadyMarkedDelivered?: boolean;
    preserveDeliveryClaim?: boolean;
    maxChars?: number;
    maxBytes?: number;
  }

  const trackPendingFinalRetry = (retry: FinalPushRetryRequest): boolean => {
    if (
      !isCurrentReplyActivation() ||
      (supersededByNewInbound && suppressSupersededFinalPush)
    ) {
      if (retry.alreadyMarkedDelivered && !retry.preserveDeliveryClaim) {
        rollbackFinalDelivered(retry.deliveryKey, { peerDedup: retry.peerDedup });
      }
      return false;
    }
    let pendingRetries = pendingFinalRetryByPeer.get(replyPeerKey);
    if (!pendingRetries) {
      pendingRetries = new Map();
      pendingFinalRetryByPeer.set(replyPeerKey, pendingRetries);
    }
    pendingFinalRetryClaim = retry.alreadyMarkedDelivered
      ? {
          deliveryKey: retry.deliveryKey,
          peerDedup: retry.peerDedup,
          preserve: retry.preserveDeliveryClaim === true,
        }
      : undefined;
    pendingRetries.set(activationId, {
      cancel: () => {
        obsoleteFinalRetry = true;
        finishPendingFinalRetry(true);
      },
      // A newer activation owning the peer is NOT a reason to destroy an answer
      // the user never received — that is a silently dropped message. Cancel
      // only once a chunk of THIS push is confirmed delivered, where re-pushing
      // would duplicate what they already have.
      shouldCancelForNewActivation: () => (finalPushProgress?.delivered ?? 0) > 0,
    });
    return true;
  };

  // Bounded retry chain for finals whose fallback push failed. Without it a
  // failed active push after stream expiry silently drops the answer
  // (rollbackFinalDelivered + return). Timers live in this closure, so each
  // req_id/session retries independently; run-time guards keep B3 supersede
  // semantics (a suppressed superseded final is never re-pushed).
  const runFinalPushRetry = async (retry: FinalPushRetryRequest): Promise<void> => {
    if (!ensureRuntimeCleanup() || !isCurrentReplyActivation()) {
      finishPendingFinalRetry(true);
      console.info(
        `[wecom-b3] final-retry-skip-obsolete account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
      );
      return;
    }
    if (
      supersededByNewInbound &&
      (suppressSupersededFinalPush ||
        (visibleReplyStarted && (finalPushProgress?.delivered ?? 0) > 0))
    ) {
      // Recompute suppression at fire time: a superseded final that became
      // partially visible mid-push (chunks confirmed after the supersede
      // froze suppressSupersededFinalPush=false) must not revive its
      // remaining chunks into the newest conversation.
      finishPendingFinalRetry(true);
      console.info(
        `[wecom-b3] final-retry-skip-superseded account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
      );
      return;
    }
    if (
      !retry.alreadyMarkedDelivered &&
      !markFinalDelivered(retry.deliveryKey, { peerDedup: retry.peerDedup })
    ) {
      finishPendingFinalRetry(false);
      return;
    }
    pendingFinalRetryClaim = {
      deliveryKey: retry.deliveryKey,
      peerDedup: retry.peerDedup,
      preserve: retry.preserveDeliveryClaim === true,
    };
    try {
      await sendMarkdownChunksViaActivePush(retry.text, {
        reason: "final-retry",
        appendCompletionMarker: retry.appendCompletionMarker,
        progress: resolveFinalPushProgress(retry.text, retry.appendCompletionMarker, {
          maxChars: retry.maxChars,
          maxBytes: retry.maxBytes,
        }),
        maxChars: retry.maxChars,
        maxBytes: retry.maxBytes,
        isObsolete: () => !isCurrentReplyActivation(),
      });
      if (!isCurrentReplyActivation()) {
        finishPendingFinalRetry(true);
        return;
      }
      finishPendingFinalRetry(false);
      visibleReplyStarted = true;
      console.info(
        `[wecom-b3] final-retry-delivered attempt=${finalPushRetryCount}/${FINAL_PUSH_MAX_RETRIES} account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
      );
      params.onDeliver?.();
    } catch (error) {
      if (error === OBSOLETE_FINAL_RETRY) {
        finishPendingFinalRetry(true);
        console.info(
          `[wecom-b3] final-retry-stop-obsolete account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
        );
        return;
      }
      const ambiguous = isAmbiguousActivePushDeliveryError(error);
      if (!ambiguous && !retry.alreadyMarkedDelivered) {
        rollbackFinalDelivered(retry.deliveryKey, { peerDedup: retry.peerDedup });
        pendingFinalRetryClaim = undefined;
      }
      console.warn(
        `[wecom-b3] final-retry-failed attempt=${finalPushRetryCount}/${FINAL_PUSH_MAX_RETRIES} ambiguous=${String(ambiguous)} account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
      );
      if (finalPushRetryCount >= FINAL_PUSH_MAX_RETRIES) {
        finishPendingFinalRetry(true);
        console.warn(
          `[wecom-b3] final-retry-exhausted account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
        );
        sendRetryExhaustedNoticeOnce();
        params.onFail?.(error);
        return;
      }
      // Ambiguous failures (ack/local timeout, dropped socket) MAY have
      // reached the user; keep the delivery claim so the next attempt only
      // resends unconfirmed chunks via the tracked push progress. Stopping
      // here instead used to silently destroy the whole answer.
      scheduleFinalPushRetry(
        ambiguous ? { ...retry, alreadyMarkedDelivered: true, preserveDeliveryClaim: true } : retry,
      );
    }
  };

  // Closes the dangling "完成后将以新消息发送"/placeholder promise when every
  // final delivery attempt is spent; without it the answer disappears with
  // only a log line.
  const sendRetryExhaustedNoticeOnce = (): void => {
    if (isEvent || failNoticeSent || supersededByNewInbound || !isCurrentReplyActivation()) {
      // A superseded/obsolete chain must not push a stale failure notice
      // into the middle of the successor conversation.
      return;
    }
    failNoticeSent = true;
    void sendMarkdownChunksViaActivePush(REPLY_FAIL_NOTICE_TEXT, {
      reason: "fail-notice",
    }).catch((noticeError) => {
      console.warn(
        `[wecom-reply] fail-notice-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(noticeError)}`,
      );
    });
  };

  const scheduleFinalPushRetry = (retry: FinalPushRetryRequest): void => {
    if (!ensureRuntimeCleanup()) {
      finishPendingFinalRetry(true);
      return;
    }
    if (supersededByNewInbound && suppressSupersededFinalPush) {
      finishPendingFinalRetry(true);
      return;
    }
    if (finalPushRetryTimer) {
      return;
    }
    if (finalPushRetryCount >= FINAL_PUSH_MAX_RETRIES) {
      finishPendingFinalRetry(true);
      return;
    }
    if (!trackPendingFinalRetry(retry)) {
      finishPendingFinalRetry(true);
      return;
    }
    const delayMs = FINAL_PUSH_RETRY_BASE_MS * 2 ** finalPushRetryCount;
    finalPushRetryCount += 1;
    console.warn(
      `[wecom-b3] final-retry-scheduled attempt=${finalPushRetryCount}/${FINAL_PUSH_MAX_RETRIES} delayMs=${delayMs} account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
    );
    finalPushRetryTimer = setTimeout(() => {
      finalPushRetryTimer = undefined;
      void runFinalPushRetry(retry);
    }, delayMs);
    finalPushRetryTimer.unref?.();
  };

  // A failed turn whose work was all tool calls has no visible body at all, and
  // by then a long task's stream window is usually closed, so the push route
  // would deliver one bare provider line — no hint of what ran or for how long.
  // The reasoning itself stays out: it is only ever shown inside the collapsed
  // <think> block, never promoted to visible text.
  //
  // The elapsed value is snapshotted on first use: this text IS the retry
  // identity, and a drifting timestamp would reset the tracked chunk progress
  // and re-push chunks the user already received.
  let failureContextElapsedMs: number | undefined;
  const withFailureContext = (errorText: string): string => {
    failureContextElapsedMs ??= Date.now() - handleStartedAt;
    return `⚠️ 本次任务未完成（已运行 ${formatElapsedDuration(failureContextElapsedMs)}）：\n\n${errorText}`;
  };

  /** Visible body the user has not been shown yet, "" when it cannot be aligned. */
  const resolveUndeliveredProgressText = (bodyText: string): string => {
    if (!bodyText) {
      return "";
    }
    const deliveredSourceText = previewFrozenDeliveredSourceText || lastDeliveredBodySourceText;
    if (!deliveredSourceText) {
      return bodyText;
    }
    return bodyText.startsWith(deliveredSourceText)
      ? bodyText.slice(deliveredSourceText.length).trimStart()
      : "";
  };

  const resolveStreamFallbackText = (finalText: string, isError = false): string => {
    const deliveredSourceText = previewFrozenDeliveredSourceText || lastDeliveredBodySourceText;
    if (!deliveredSourceText || !finalText.startsWith(deliveredSourceText)) {
      return isError ? withFailureContext(finalText) : finalText;
    }
    const remainder = finalText.slice(deliveredSourceText.length).trimStart();
    if (!remainder) {
      return isError
        ? "任务未完成，以上为本次已完成的进度。"
        : "最终回复已完成，以上预览内容即为完整回复。";
    }
    if (remainder === FINAL_COMPLETION_MARKER) {
      return FINAL_COMPLETION_MARKER;
    }
    return `${isError ? "任务未完成" : "继续输出"}：\n\n${remainder}`;
  };

  // Renders the accumulated reasoning ahead of a final frame using only the
  // room that frame has left. The answer keeps the full 12 000-byte budget; the
  // reasoning shrinks, or drops out entirely, if there is nothing spare.
  const prependThinkingWithinFrameBudget = (bodyText: string): string => {
    const availableChars =
      WECOM_STREAM_FINAL_MAX_CHARS - bodyText.length - THINK_BLOCK_WRAPPER_CHARS;
    const availableBytes =
      WECOM_STREAM_MAX_BYTES -
      Buffer.byteLength(bodyText, "utf8") -
      THINK_BLOCK_WRAPPER_BYTES;
    if (availableChars <= 0 || availableBytes <= 0) {
      return bodyText;
    }
    const thinkingBlock = renderInlineThinkBlock(
      accumulatedThinkingText,
      availableBytes,
      availableChars,
    );
    return thinkingBlock ? `${thinkingBlock}\n${bodyText}` : bodyText;
  };

  const deliverNormalFinalViaStream = async (
    finalText: string,
    options: {
      appendCompletionMarker: boolean;
      deliveryKey: string;
      peerDedup: boolean;
      isError: boolean;
    },
  ): Promise<boolean | "retry-scheduled"> => {
    const markdownChunks = chunkWeComMarkdownWireV2(
      finalText,
      WECOM_STREAM_FINAL_MAX_CHARS,
      WECOM_STREAM_MAX_BYTES,
      options.appendCompletionMarker,
    );
    const finalStreamId = resolveStreamId();
    const firstStreamChunk = markdownChunks[0] ?? "";
    // A stream frame replaces the whole bubble, so an error final would erase
    // the reasoning the user has been watching and leave a failed long task
    // showing nothing but a one-line error. The reasoning is decoration: it
    // rides in whatever the frame has left and must never shrink the answer's
    // own chunking, which would fragment the remainder into extra messages.
    const firstStreamContent =
      options.isError && accumulatedThinkingText
        ? prependThinkingWithinFrameBudget(firstStreamChunk)
        : firstStreamChunk;
    let fallbackText = resolveStreamFallbackText(finalText, options.isError);
    const fallbackAppendCompletionMarker = !options.isError;
    // The fallback retry must reuse the EXACT identity of the failed push
    // (text/marker/default limits): any drift would reset the tracked chunk
    // progress and re-push chunks the user already confirmed-received.
    const fallbackRetryRequest = (): FinalPushRetryRequest => ({
      text: fallbackText,
      deliveryKey: options.deliveryKey,
      peerDedup: options.peerDedup,
      appendCompletionMarker: fallbackAppendCompletionMarker,
      alreadyMarkedDelivered: true,
      preserveDeliveryClaim: true,
    });
    const settleActivePushFailure = (error: unknown): false | "retry-scheduled" => {
      params.onFail?.(error);
      if (isAmbiguousActivePushDeliveryError(error)) {
        // The push MAY have reached the user; keep the delivery claim and
        // retry only the unconfirmed chunks instead of dropping the answer.
        scheduleFinalPushRetry(fallbackRetryRequest());
        return "retry-scheduled";
      }
      return false;
    };
    refreshCallbackStreamOwnership();
    if (streamUpdateUnreliable) {
      console.warn(
        `[wecom-b3] stream-final-skip-unreliable account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId}`,
      );
      try {
        await sendMarkdownChunksViaActivePush(fallbackText, {
          reason: "stream-fallback",
          appendCompletionMarker: fallbackAppendCompletionMarker,
          progress: resolveFinalPushProgress(fallbackText, fallbackAppendCompletionMarker),
        });
        visibleReplyStarted = true;
      } catch (fallbackError) {
        return settleActivePushFailure(fallbackError);
      }
      return true;
    }
    const pendingAckCleared = await waitForPendingReplyAckToClear({
      client: params.client,
      frame: params.frame,
      hasLocalPendingReply: () => placeholderInFlight || previewInFlightCount > 0,
    });
    if (runtimeRetired) {
      return false;
    }
    // A preview can settle while final waits for the SDK queue. Recompute from
    // the confirmed bookmark so fallback sends only the still-undelivered tail.
    fallbackText = resolveStreamFallbackText(finalText, options.isError);
    // Re-check supersede after the await gap above (up to 5.5s): a new
    // inbound may have superseded this handle while we waited for the pending
    // ack. Without this check the old final would be flushed into the old
    // stream bubble with finish=true — the "stale bubble revival" race.
    if (supersededByNewInbound) {
      if (suppressSupersededFinalPush) {
        console.info(
          `[wecom-b3] stream-final-skip-superseded account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId}`,
        );
        return false;
      }
      console.info(
        `[wecom-b3] stream-final-superseded-push account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId}`,
      );
      try {
        await sendMarkdownChunksViaActivePush(fallbackText, {
          reason: "superseded-final",
          appendCompletionMarker: fallbackAppendCompletionMarker,
          progress: resolveFinalPushProgress(fallbackText, fallbackAppendCompletionMarker),
        });
        visibleReplyStarted = true;
      } catch (fallbackError) {
        return settleActivePushFailure(fallbackError);
      }
      return true;
    }
    if (!pendingAckCleared) {
      console.warn(
        `[wecom-b3] stream-final-skip-pending-ack account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId}`,
      );
      try {
        await sendMarkdownChunksViaActivePush(fallbackText, {
          reason: "stream-fallback",
          appendCompletionMarker: fallbackAppendCompletionMarker,
          progress: resolveFinalPushProgress(fallbackText, fallbackAppendCompletionMarker),
        });
        visibleReplyStarted = true;
      } catch (fallbackError) {
        return settleActivePushFailure(fallbackError);
      }
      return true;
    }
    if (streamDeliveryUntrusted()) {
      console.warn(
        `[wecom-b3] stream-final-skip-unreliable account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId}`,
      );
      try {
        await sendMarkdownChunksViaActivePush(fallbackText, {
          reason: "stream-fallback",
          appendCompletionMarker: fallbackAppendCompletionMarker,
          progress: resolveFinalPushProgress(fallbackText, fallbackAppendCompletionMarker),
        });
        visibleReplyStarted = true;
      } catch (fallbackError) {
        return settleActivePushFailure(fallbackError);
      }
      return true;
    }

    try {
      console.info(
        `[wecom-b3] stream-final account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId} chunks=${markdownChunks.length}`,
      );
      await withHandleSendTimeout(
        params.client.replyStream(params.frame, finalStreamId, firstStreamContent, true),
        "stream final",
      );
      visibleReplyStarted = true;
    } catch (error) {
      if (isTerminalReplyError(error)) {
        console.warn(
          `[wecom-b3] stream-final-terminal-fallback account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId} error=${formatFallbackError(error)}`,
        );
        try {
          await sendMarkdownChunksViaActivePush(fallbackText, {
            reason: "stream-fallback",
            appendCompletionMarker: fallbackAppendCompletionMarker,
            progress: resolveFinalPushProgress(fallbackText, fallbackAppendCompletionMarker),
          });
          visibleReplyStarted = true;
        } catch (fallbackError) {
          return settleActivePushFailure(fallbackError);
        }
        return true;
      }
      console.warn(
        `[wecom-b3] stream-final-fallback account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId} error=${formatFallbackError(error)}`,
      );
      try {
        await sendMarkdownChunksViaActivePush(fallbackText, {
          reason: "stream-fallback",
          appendCompletionMarker: fallbackAppendCompletionMarker,
          progress: resolveFinalPushProgress(fallbackText, fallbackAppendCompletionMarker),
        });
        visibleReplyStarted = true;
      } catch (fallbackError) {
        return settleActivePushFailure(fallbackError);
      }
      return true;
    }

    if (supersededByNewInbound && markdownChunks.length > 1) {
      // The first final chunk is now confirmed visible. Preserve the v118
      // supersede rule and do not interleave its old remainder with the new reply.
      suppressSupersededFinalPush = true;
      obsoleteFinalRetry = true;
      console.info(
        `[wecom-b3] stream-remainder-skip-superseded account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId}`,
      );
      return false;
    }

    if (markdownChunks.length > 1) {
      const progress = resolveFinalPushProgress(finalText, options.appendCompletionMarker, {
        maxChars: WECOM_STREAM_FINAL_MAX_CHARS,
        maxBytes: WECOM_STREAM_MAX_BYTES,
      });
      const retryRequest: FinalPushRetryRequest = {
        text: finalText,
        deliveryKey: options.deliveryKey,
        peerDedup: options.peerDedup,
        appendCompletionMarker: options.appendCompletionMarker,
        alreadyMarkedDelivered: true,
        preserveDeliveryClaim: true,
        maxChars: WECOM_STREAM_FINAL_MAX_CHARS,
        maxBytes: WECOM_STREAM_MAX_BYTES,
      };
      progress.delivered = Math.max(progress.delivered, 1);
      if (!trackPendingFinalRetry(retryRequest)) {
        return "retry-scheduled";
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      try {
        await sendMarkdownChunksViaActivePush(finalText, {
          reason: "stream-remainder",
          appendCompletionMarker: options.appendCompletionMarker,
          progress,
          maxChars: WECOM_STREAM_FINAL_MAX_CHARS,
          maxBytes: WECOM_STREAM_MAX_BYTES,
          isObsolete: () => !isCurrentReplyActivation(),
        });
        if (!isCurrentReplyActivation()) {
          finishPendingFinalRetry(true);
          return "retry-scheduled";
        }
        finishPendingFinalRetry(false);
      } catch (error) {
        if (error === OBSOLETE_FINAL_RETRY) {
          finishPendingFinalRetry(true);
          return "retry-scheduled";
        }
        // Ambiguous failures reschedule the SAME retryRequest as non-ambiguous
        // ones: rebuilding the retry with a different text/marker/limit
        // identity would reset the tracked chunk progress and re-push already
        // confirmed chunks from zero.
        console.warn(
          `[wecom-b2] stream-remainder-retry ambiguous=${String(isAmbiguousActivePushDeliveryError(error))} account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId} error=${formatFallbackError(error)}`,
        );
        scheduleFinalPushRetry(retryRequest);
        return "retry-scheduled";
      }
    }
    return true;
  };

  const closeOpenedStreamSilently = async (content = ""): Promise<void> => {
    if (streamSettled) {
      return;
    }
    const finalStreamId = streamId;
    settleStream();
    if (!finalStreamId || isEvent || supersededByNewInbound || streamDeliveryUntrusted()) {
      // A dead stream would reject the source-stream close with a guaranteed 846608;
      // settling locally is all the cleanup an expired window needs.
      return;
    }
    const pendingAckCleared = await waitForPendingReplyAckToClear({
      client: params.client,
      frame: params.frame,
      timeoutMs: WECOM_REPLY_SEND_TIMEOUT_MS,
      hasLocalPendingReply: () => placeholderInFlight || previewInFlightCount > 0,
    });
    if (!pendingAckCleared || supersededByNewInbound || streamDeliveryUntrusted()) {
      params.onFail?.(new Error("WeCom source final stream ACK did not clear."));
      return;
    }
    try {
      await withHandleSendTimeout(
        params.client.replyStream(params.frame, finalStreamId, content, true),
        "source stream final",
      );
      params.onDeliver?.();
    } catch (error) {
      params.onFail?.(error);
    }
  };

  const prependThinkingToPreviewWire = (bodyText: string): string => {
    const thinkingBlock = renderInlineThinkBlock(accumulatedThinkingText);
    return thinkingBlock ? `${thinkingBlock}\n${bodyText}` : bodyText;
  };

  const renderPreviewFrame = (
    sourceText: string,
    now = Date.now(),
  ): { text: string; bodySourceText?: string } => {
    const thinkingLimits = resolveThinkingAwareBodyLimits(accumulatedThinkingText);
    const elapsedMs = now - handleStartedAt;
    if (
      sourceText &&
      !previewFrozen &&
      (elapsedMs >= BLOCK_PREVIEW_MAX_MS || sourceText.length >= BLOCK_PREVIEW_MAX_CHARS)
    ) {
      previewFrozen = true;
      previewFrozenSourceText = sliceUtf16SafePrefix(sourceText, BLOCK_PREVIEW_MAX_CHARS);
      // Self-healing: start the status refresh interval at freeze time
      // instead of waiting for the first frozen preview send to succeed —
      // a skipped/failed first send would otherwise leave the counter dead.
      startPreviewStatusInterval();
    }

    const sourceLimit = previewFrozen
      ? (previewFrozenSourceText || sliceUtf16SafePrefix(sourceText, BLOCK_PREVIEW_MAX_CHARS))
      : sourceText;
    let bodyPreview: RenderedPreviewSource;
    if (previewFrozen) {
      if (elapsedMs >= LONG_TASK_STATUS_AFTER_MS) {
        const composed = composePreviewSuffixWithinLimits({
          prefix: sourceLimit,
          suffix: formatElapsedStatus(elapsedMs),
          maxChars: thinkingLimits.maxChars,
          maxBytes: thinkingLimits.maxBytes,
        });
        bodyPreview = { text: composed.text, sourceText: composed.visiblePrefix };
      } else {
        bodyPreview = renderPreviewSourcePrefixWithinLimits({
          sourceText: sourceLimit,
          maxChars: thinkingLimits.maxChars,
          maxBytes: thinkingLimits.maxBytes,
        });
      }
      previewFrozenText ||= bodyPreview.text;
    } else {
      bodyPreview = renderPreviewSourcePrefixWithinLimits({
        sourceText: sourceLimit,
        maxChars: thinkingLimits.maxChars,
        maxBytes: thinkingLimits.maxBytes,
      });
    }

    return {
      text: prependThinkingToPreviewWire(bodyPreview.text),
      bodySourceText: sourceText ? bodyPreview.sourceText : undefined,
    };
  };

  const stopPreviewExpiredNoticeTimer = (): void => {
    if (previewExpiredNoticeTimer) {
      clearTimeout(previewExpiredNoticeTimer);
      previewExpiredNoticeTimer = undefined;
    }
  };

  const disarmPreviewExpiredNotice = (): void => {
    stopPreviewExpiredNoticeTimer();
    previewExpiredNoticeStarted = false;
    previewExpiredNoticeAllowUnfrozen = false;
  };

  const cancelPreviewExpiredNotice = (): void => {
    previewExpiredNoticeCancelled = true;
    disarmPreviewExpiredNotice();
  };

  // An external message just reached this peer, so push the recurring notice
  // out by one interval rather than retiring it. Cancelling here used to
  // silence a running long task for the rest of its turn — one spawned task's
  // completion push was enough to stop every later progress update.
  const deferPreviewExpiredNotice = (): void => {
    if (!previewExpiredNoticeStarted) {
      return;
    }
    stopPreviewExpiredNoticeTimer();
    // Re-arm on the shared grid, not "one interval from now": an external
    // message must not be able to drag the status schedule around either.
    schedulePreviewExpiredNotice(
      Math.max(0, nextLongTaskStatusDueAt() - Date.now()),
      previewExpiredNoticeAllowUnfrozen,
    );
  };

  // Recurring active push after the frozen preview channel dies (typically
  // errcode 846608 once the WeCom stream window closes at ~6 min). Without
  // it the bubble goes silent forever while the task is still running. The
  // first push is held until the task has been processing for at least
  // PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS, then repeats on the shared status cadence until
  // final settlement or supersede. Recursive timeouts avoid overlapping
  // sends when a push itself is slow.
  const schedulePreviewExpiredNotice = (delayMs: number, allowUnfrozen: boolean): void => {
    if (
      !ensureRuntimeCleanup() ||
      previewExpiredNoticeTimer ||
      previewExpiredNoticeInFlight ||
      previewExpiredNoticeCancelled ||
      streamSettled ||
      finalDelivered ||
      isEvent ||
      supersededByNewInbound
    ) {
      return;
    }
    previewExpiredNoticeStarted = true;
    previewExpiredNoticeAllowUnfrozen = allowUnfrozen;
    previewExpiredNoticeTimer = setTimeout(() => {
      previewExpiredNoticeTimer = undefined;
      maybeSendPreviewExpiredNotice(allowUnfrozen);
    }, delayMs);
    previewExpiredNoticeTimer.unref?.();
  };

  const maybeSendPreviewExpiredNotice = (allowUnfrozen = false): void => {
    if (
      !ensureRuntimeCleanup() ||
      previewExpiredNoticeInFlight ||
      previewExpiredNoticeCancelled ||
      (!previewFrozen && !allowUnfrozen) ||
      streamSettled ||
      finalDelivered ||
      isEvent ||
      supersededByNewInbound
    ) {
      return;
    }
    previewExpiredNoticeStarted = true;
    previewExpiredNoticeAllowUnfrozen = allowUnfrozen;
    const taskElapsedMs = Date.now() - handleStartedAt;
    if (taskElapsedMs < PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS) {
      if (!previewExpiredNoticeTimer) {
        const remainingMs = PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS - taskElapsedMs;
        console.info(
          `[wecom-preview] expired-notice-deferred delayMs=${remainingMs} account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
        );
        schedulePreviewExpiredNotice(remainingMs, allowUnfrozen);
      }
      return;
    }
    // The bubble is unrepaintable but the agent keeps producing: carry whatever
    // the user has not seen out with the status line instead of dropping it.
    // Reasoning stays out — only the visible body travels this way.
    const progressSnapshot = accumulatedText;
    const undeliveredProgress = resolveUndeliveredProgressText(progressSnapshot);
    const transientProgressSnapshot = latestTransientProgressText;
    const undeliveredTransientProgress =
      transientProgressSnapshot &&
      transientProgressSnapshot !== lastDeliveredTransientProgressText
        ? transientProgressSnapshot
        : "";
    const now = Date.now();
    // Real content still goes out as soon as it exists — that is what this push
    // is for. A status-only push, though, is the same line the bubble may have
    // painted seconds ago, so it has to wait for its slot on the shared clock;
    // firing it on arming is what delivered the same status twice, 5 s apart.
    if (!undeliveredProgress && !undeliveredTransientProgress && !isLongTaskStatusDue(now)) {
      if (!previewExpiredNoticeTimer) {
        schedulePreviewExpiredNotice(
          Math.max(0, nextLongTaskStatusDueAt() - now),
          allowUnfrozen,
        );
      }
      return;
    }
    stopPreviewExpiredNoticeTimer();
    previewExpiredNoticeInFlight = true;
    // Same rule as the bubble lane: the slot is spent on dispatch. A push that
    // fails is no more provably unseen than a frame with a missing ACK, so it
    // does not hand the slot back and cannot make two lanes race for it.
    markLongTaskStatusPainted(now);
    const elapsedMs = now - handleStartedAt;
    const noticeText = [
      undeliveredProgress,
      undeliveredTransientProgress,
      formatElapsedStatus(elapsedMs),
    ]
      .filter(Boolean)
      .join("\n\n");
    void sendMarkdownChunksViaActivePush(
      noticeText,
      {
        reason: "preview-expired",
        isObsolete: () => streamSettled || finalDelivered || supersededByNewInbound,
      },
    )
      .then(() => {
        if (undeliveredProgress) {
          // Only after a confirmed push: the final resolves its remainder from
          // this bookkeeping, so advancing it on a failed push would lose text.
          recordDeliveredBodySource({ bodySourceText: progressSnapshot });
        }
        if (undeliveredTransientProgress) {
          lastDeliveredTransientProgressText = transientProgressSnapshot;
        }
        console.info(
          `[wecom-preview] expired-notice account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} elapsedMs=${elapsedMs} progressChars=${undeliveredProgress.length} transientChars=${undeliveredTransientProgress.length}`,
        );
      })
      .catch((error) => {
        if (error === OBSOLETE_FINAL_RETRY) {
          return;
        }
        console.warn(
          `[wecom-preview] expired-notice-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
        );
      })
      .finally(() => {
        previewExpiredNoticeInFlight = false;
        if (previewExpiredNoticeStarted) {
          schedulePreviewExpiredNotice(
            Math.max(0, nextLongTaskStatusDueAt() - Date.now()),
            allowUnfrozen,
          );
        }
      });
  };

  const recordDeliveredBodySource = (
    options?: PreviewDeliveryMetadata,
  ): void => {
    if (options?.bodySourceText === undefined) {
      return;
    }
    lastDeliveredBodySourceText = options?.bodySourceText ?? "";
    if (previewFrozen) {
      previewFrozenDeliveredSourceText = options?.bodySourceText ?? "";
    }
  };

  const recordDeliveredTransientProgress = (options?: PreviewDeliveryMetadata): void => {
    if (options?.transientProgressText === undefined) {
      return;
    }
    lastDeliveredTransientProgressText = options.transientProgressText;
  };

  const sendForcedTransientProgress = async (text: string): Promise<boolean> => {
    if (!forceActivePushRequired()) {
      return false;
    }
    if (!text || text === lastDeliveredTransientProgressText) {
      return true;
    }
    try {
      await sendMarkdownChunksViaActivePush(text, {
        reason: "forced-progress",
        isObsolete: () => streamSettled || finalDelivered || supersededByNewInbound,
      });
      lastDeliveredTransientProgressText = text;
    } catch (error) {
      if (error !== OBSOLETE_FINAL_RETRY) {
        console.warn(
          `[wecom-preview] forced-progress-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} error=${formatFallbackError(error)}`,
        );
      }
    }
    return true;
  };

  // Reasoning-only previews render as a collapsed <think> block: the user has
  // not seen any visible reply body yet. Treating them as "visible reply
  // started" made supersede silently discard the run's real final answer.
  // Body-carrying callers always pass a bodySourceText STRING — possibly ""
  // when the markdown adapter transformed the body beyond source mapping — so
  // presence (not truthiness) is normally the visibility signal. A transient
  // full-frame progress update may explicitly clear the current body bookmark
  // without counting as visible answer text.
  const previewShowsVisibleBody = (
    options?: PreviewDeliveryMetadata,
  ): boolean =>
    options?.showsVisibleBody ??
    Boolean(options && options.bodySourceText !== undefined);

  const recordDeliveredPreview = (
    previewText: string,
    now: number,
    options?: PreviewDeliveryMetadata,
  ): void => {
    if (streamSettled || supersededByNewInbound) {
      return;
    }
    if (!streamUpdateUnreliable) {
      // The lane just proved it can still paint, so the deferred background
      // notice armed by an earlier missing ACK is no longer warranted. A
      // retired lane keeps its notice: nothing will ever confirm it again.
      disarmPreviewExpiredNotice();
    }
    if (previewShowsVisibleBody(options)) {
      visibleReplyStarted = true;
    }
    lastPreviewText = previewText;
    lastPreviewUpdateAt = now;
    // ANY confirmed repaint counts against the status slot, not just one that
    // literally carries the status line. The status only ever means "still
    // working", and a fresh progress frame proves that better — without this,
    // a progress frame landing just after the gate was immediately followed by
    // a status frame a second or two later. Stamp the CONFIRMATION time, not
    // `now`: `now` is when the frame was composed, which for a slow ACK can be
    // before the gate and would leave the slot looking unspent.
    markLongTaskStatusPainted();
    recordDeliveredBodySource(options);
    recordDeliveredTransientProgress(options);
    if (previewFrozen) {
      stopPreviewFreezeTimeout();
      startPreviewStatusInterval();
    } else {
      scheduleHeartbeat();
    }
  };

  const sendPreviewUpdate = async (
    previewText: string,
    now: number,
    options?: PreviewDeliveryMetadata & { fromPendingSlot?: boolean },
  ): Promise<boolean> => {
    if (forceActivePushRequired()) {
      maybeSendPreviewExpiredNotice(true);
      return false;
    }
    if (streamSettled || isEvent || supersededByNewInbound || streamUpdateUnreliable) {
      return false;
    }
    const previewStreamId = resolveStreamId();
    const directAttempt = options?.fromPendingSlot !== true;
    if (directAttempt) {
      pausePlaceholderHeartbeat();
    }
    if (
      directAttempt &&
      (placeholderInFlight ||
        previewInFlightCount > 0 ||
        pendingPreviewFlushInFlight ||
        hasPendingReplyAck(params.client, params.frame))
    ) {
      queuePendingPreview(previewText, options);
      console.info(
        `[wecom-preview] update-delayed-pending account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${previewStreamId}`,
      );
      return false;
    }
    if (directAttempt && pendingPreview) {
      clearPendingPreview();
    }

    previewInFlightCount += 1;
    const previewSendPromise = sendNonFinalStreamUpdate({
      client: params.client,
      frame: params.frame,
      streamId: previewStreamId,
      content: previewText,
    });
    try {
      const result = await withHandleSendTimeout(previewSendPromise, "stream preview");
      if (result === "skipped") {
        console.info(
          `[wecom-preview] update-skipped-pending account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${previewStreamId}`,
        );
        if (directAttempt && !pendingPreview) {
          queuePendingPreview(previewText, options);
        }
        return false;
      }
    } catch (error) {
      if (isLocalReplyTimeoutError(error)) {
        void previewSendPromise.then(
          (result) => {
            if (
              result === "skipped" ||
              supersededByNewInbound
            ) {
              return;
            }
            if (!refreshCallbackStreamOwnership()) {
              // The old frame may have surfaced after our local timeout, but it
              // no longer proves the current bubble contains this body. Keep
              // the bookmark conservative so active-push final sends it again.
              maybeSendPreviewExpiredNotice(true);
              return;
            }
            if (streamSettled) {
              if (previewShowsVisibleBody(options)) {
                visibleReplyStarted = true;
              }
              recordDeliveredBodySource(options);
              recordDeliveredTransientProgress(options);
            } else {
              recordDeliveredPreview(previewText, now, options);
            }
            console.info(
              `[wecom-preview] late-delivery-confirmed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${previewStreamId}`,
            );
          },
          () => undefined,
        );
      }
      if (isDeadStreamError(error)) {
        console.warn(
          `[wecom-preview] terminal-update-stopped account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${previewStreamId} error=${formatFallbackError(error)}`,
        );
        streamUpdateUnreliable = true;
        clearPendingPreview();
        stopPreviewFreezeTimeout();
        stopPreviewStatusInterval();
        // allowUnfrozen: reasoning-only bubbles (and pre-freeze deaths) never
        // freeze the preview, yet their tasks equally deserve the deferred
        // background notice — the long-task gate itself filters short tasks.
        maybeSendPreviewExpiredNotice(true);
        return false;
      }
      if (isTerminalReplyError(error)) {
        // One unacknowledged frame is a gateway hiccup, not a dead stream.
        // Latching the whole lane off here cost the user every later thinking
        // block and progress update of the turn, permanently, after a single
        // 5 s ACK timeout — keep painting progress and only distrust this
        // stream for deliveries that must be proven.
        console.warn(
          `[wecom-preview] update-ack-missing account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${previewStreamId} error=${formatFallbackError(error)}`,
        );
        streamAckUnreliable = true;
        // If the ACKs never come back, this bubble may already be frozen for
        // the rest of the task, and the deferred background push is the only
        // feedback left. Arm it now — a confirmed preview disarms it again, so
        // a single hiccup on a healthy stream costs the user nothing.
        maybeSendPreviewExpiredNotice(true);
        if (directAttempt && !pendingPreview) {
          queuePendingPreview(previewText, options);
        }
        return false;
      }
      console.warn(
        `[wecom-preview] update-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${previewStreamId} error=${formatFallbackError(error)}`,
      );
      if (directAttempt && !pendingPreview) {
        queuePendingPreview(previewText, options);
      }
      return false;
    } finally {
      previewInFlightCount = Math.max(0, previewInFlightCount - 1);
      if (supersededByNewInbound && !streamUpdateUnreliable) {
        closeSupersededPlaceholder();
      }
    }

    if (supersededByNewInbound) {
      return false;
    }
    if (streamSettled || streamUpdateUnreliable) {
      if (previewShowsVisibleBody(options)) {
        visibleReplyStarted = true;
      }
      recordDeliveredBodySource(options);
      recordDeliveredTransientProgress(options);
      return false;
    }
    recordDeliveredPreview(previewText, now, options);
    return true;
  };

  function queuePendingPreview(
    previewText: string,
    options?: PreviewDeliveryMetadata,
  ): void {
    if (
      !previewText ||
      streamSettled ||
      isEvent ||
      supersededByNewInbound ||
      streamUpdateUnreliable
    ) {
      return;
    }
    pendingPreview = {
      text: previewText,
      bodySourceText: options?.bodySourceText,
      showsVisibleBody: options?.showsVisibleBody,
      transientProgressText: options?.transientProgressText,
      deadline: pendingPreview?.deadline ?? Date.now() + WECOM_PENDING_ACK_GRACE_MS,
      retryCount: pendingPreview?.retryCount ?? 0,
    };
    schedulePendingPreviewPoll();
  }

  function schedulePendingPreviewPoll(): void {
    if (pendingPreviewPollTimer || pendingPreviewFlushInFlight || !pendingPreview) {
      return;
    }
    pendingPreviewPollTimer = setTimeout(() => {
      pendingPreviewPollTimer = undefined;
      void flushPendingPreview().catch((error) => {
        console.warn(
          `[wecom-preview] pending-flush-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} error=${formatFallbackError(error)}`,
        );
      });
    }, WECOM_PENDING_ACK_POLL_MS);
  }

  async function flushPendingPreview(): Promise<void> {
    if (
      !pendingPreview ||
      streamSettled ||
      isEvent ||
      supersededByNewInbound ||
      streamUpdateUnreliable
    ) {
      clearPendingPreview();
      return;
    }
    if (Date.now() >= pendingPreview.deadline) {
      // Unlike a single unacknowledged frame, this is a SUSTAINED inability to
      // write: the req_id has had an ACK pending for the whole grace window, so
      // the progress lane really is unusable and the background notice is the
      // only remaining feedback channel.
      console.warn(
        `[wecom-preview] update-delayed-expired account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
      );
      clearPendingPreview();
      streamUpdateUnreliable = true;
      stopPreviewFreezeTimeout();
      stopPreviewStatusInterval();
      maybeSendPreviewExpiredNotice(true);
      return;
    }
    if (
      placeholderInFlight ||
      previewInFlightCount > 0 ||
      hasPendingReplyAck(params.client, params.frame)
    ) {
      schedulePendingPreviewPoll();
      return;
    }

    const preview = pendingPreview;
    pendingPreview = undefined;
    pendingPreviewFlushInFlight = true;
    try {
      const delivered = await sendPreviewUpdate(preview.text, Date.now(), {
        bodySourceText: preview.bodySourceText,
        showsVisibleBody: preview.showsVisibleBody,
        transientProgressText: preview.transientProgressText,
        fromPendingSlot: true,
      });
      if (
        !delivered &&
        preview.retryCount < 1 &&
        !pendingPreview &&
        Date.now() < preview.deadline &&
        !streamSettled &&
        !supersededByNewInbound &&
        !streamUpdateUnreliable
      ) {
        pendingPreview = { ...preview, retryCount: preview.retryCount + 1 };
      }
      if (delivered && !previewFrozen) {
        schedulePreviewFreezeTimeout(Date.now());
      }
    } finally {
      pendingPreviewFlushInFlight = false;
      schedulePendingPreviewPoll();
    }
  }

  // Hard lifetime cap for the frozen status refresh. Checked BEFORE all
  // other guards so a stuck interval is always stopped, and latched so a
  // later successful send cannot re-arm the interval and spam warnings.
  const checkPreviewWatchdogExpired = (now: number): boolean => {
    if (previewWatchdogExpired) {
      stopPreviewStatusInterval();
      return true;
    }
    if (now - handleStartedAt >= PREVIEW_WATCHDOG_MAX_MS) {
      previewWatchdogExpired = true;
      console.warn(
        `[wecom-preview] status-watchdog-stopped account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} elapsedMs=${now - handleStartedAt}`,
      );
      stopPreviewStatusInterval();
      return true;
    }
    return false;
  };

  const sendFrozenPreviewStatus = async (): Promise<void> => {
    if (!ensureRuntimeCleanup() || checkPreviewWatchdogExpired(Date.now())) {
      return;
    }
    if (
      streamSettled ||
      previewStatusInFlight ||
      !previewFrozen ||
      !previewFrozenText ||
      isEvent ||
      supersededByNewInbound
    ) {
      return;
    }
    const now = Date.now();
    if (!isLongTaskStatusDue(now)) {
      return;
    }
    const preview = renderPreviewFrame(accumulatedText || previewFrozenSourceText, now);
    if (!preview.text || preview.text === lastPreviewText) {
      return;
    }
    previewStatusInFlight = true;
    try {
      await sendPreviewUpdate(preview.text, now, { bodySourceText: preview.bodySourceText });
    } finally {
      previewStatusInFlight = false;
    }
  };

  const startPreviewStatusInterval = (): void => {
    if (previewStatusInterval || streamSettled || !previewFrozen || previewWatchdogExpired) {
      return;
    }
    // A fixed-phase setInterval drifted out of step with the shared clock and
    // fired ticks that the throttle then silently dropped. Re-arm from the
    // clock each time instead, so a tick and a due slot are the same thing.
    previewStatusInterval = setTimeout(
      () => {
        previewStatusInterval = undefined;
        void sendFrozenPreviewStatus();
        startPreviewStatusInterval();
      },
      Math.max(0, nextLongTaskStatusDueAt() - Date.now()),
    );
    previewStatusInterval.unref?.();
  };

  const freezePreviewByTimeout = async (): Promise<void> => {
    if (streamSettled || previewFrozen || !accumulatedText || isEvent || supersededByNewInbound) {
      return;
    }
    const now = Date.now();
    const preview = renderPreviewFrame(accumulatedText, now);
    if (!previewFrozen || !preview.text || preview.text === lastPreviewText) {
      return;
    }
    await sendPreviewUpdate(preview.text, now, { bodySourceText: preview.bodySourceText });
  };

  const schedulePreviewFreezeTimeout = (now = Date.now()): void => {
    if (
      previewFreezeTimeout ||
      streamSettled ||
      previewFrozen ||
      !lastPreviewText ||
      isEvent ||
      supersededByNewInbound
    ) {
      return;
    }
    const delayMs = Math.max(0, BLOCK_PREVIEW_MAX_MS - (now - handleStartedAt));
    previewFreezeTimeout = setTimeout(() => {
      previewFreezeTimeout = undefined;
      void freezePreviewByTimeout();
    }, delayMs);
  };

  const shouldSendPreview = (text: string, now = Date.now()): boolean => {
    if (!text) {
      return false;
    }
    if (
      !previewFrozen &&
      (now - handleStartedAt >= BLOCK_PREVIEW_MAX_MS ||
        text.length >= BLOCK_PREVIEW_MAX_CHARS)
    ) {
      return true;
    }
    if (previewFrozen) {
      if (previewWatchdogExpired) {
        return false;
      }
      return isLongTaskStatusDue(now);
    }
    if (!lastPreviewText) {
      return true;
    }
    if (text === lastPreviewText) {
      return false;
    }
    return now - lastPreviewUpdateAt >= BLOCK_PREVIEW_MIN_UPDATE_MS;
  };

  const shouldSendThinkingPreview = (previewText: string, now = Date.now()): boolean => {
    if (!previewText || previewText === lastPreviewText) {
      return false;
    }
    if (!lastPreviewText) {
      return true;
    }
    return now - lastPreviewUpdateAt >= THINKING_PREVIEW_MIN_UPDATE_MS;
  };

  const sendThinkingSnapshot = async (params?: { force?: boolean }): Promise<void> => {
    if (isEvent || supersededByNewInbound || streamSettled || !accumulatedThinkingText) {
      return;
    }
    const now = Date.now();
    const preview = renderPreviewFrame(accumulatedText, now);
    if (!params?.force && !shouldSendThinkingPreview(preview.text, now)) {
      return;
    }
    await sendPreviewUpdate(preview.text, now, { bodySourceText: preview.bodySourceText });
  };

  const deliverBlockPreview = async (text: string): Promise<void> => {
    if (streamSettled || isEvent || supersededByNewInbound || !text) {
      return;
    }
    if (forceActivePushRequired()) {
      maybeSendPreviewExpiredNotice(true);
      return;
    }
    const now = Date.now();
    if (!shouldSendPreview(text, now)) {
      return;
    }
    const preview = renderPreviewFrame(text, now);
    if (!preview.text || preview.text === lastPreviewText) {
      return;
    }
    const delivered = await sendPreviewUpdate(preview.text, now, {
      bodySourceText: preview.bodySourceText,
    });
    if (delivered && !previewFrozen) {
      schedulePreviewFreezeTimeout(now);
    }
  };

  const closeSupersededPlaceholder = (): void => {
    if (
      isEvent ||
      supersededNoticeSent ||
      visibleReplyStarted ||
      streamSettled ||
      streamDeliveryUntrusted() ||
      placeholderInFlight ||
      previewInFlightCount > 0 ||
      hasPendingReplyAck(params.client, params.frame)
    ) {
      return;
    }
    supersededNoticeSent = true;
    const noticeStreamId = resolveStreamId();
    void withHandleSendTimeout(
      params.client.replyStream(params.frame, noticeStreamId, supersededNoticeText, true),
      "supersede notice",
    )
      .then(() => {
        console.info(
          `[wecom-b3] supersede-notice account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${noticeStreamId}`,
        );
      })
      .catch((error) => {
        if (isDeadStreamError(error)) {
          streamUpdateUnreliable = true;
        } else if (isTerminalReplyError(error)) {
          streamAckUnreliable = true;
        }
        console.warn(
          `[wecom-b3] supersede-notice-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${noticeStreamId} error=${formatFallbackError(error)}`,
        );
      });
  };

  // Opening the placeholder is pure acknowledgement: it must not wait for the
  // session prepare or the OpenClaw handoff, or a file upload stays silent for
  // the whole download. Claiming the peer (and retiring an older activation's
  // pending retry) stays in activate, which only runs once this inbound owns
  // the conversation.
  // A successful initial placeholder is enough to acknowledge an ordinary
  // turn. The next routine update is scheduled directly at the long-task gate;
  // only a failed placeholder uses the short retry delay.
  const longTaskStatusGateAt = (): number => handleStartedAt + LONG_TASK_STATUS_AFTER_MS;

  /** Next grid slot. Snapping to the grid (rather than to "last paint + one
   *  interval") stops a late paint from dragging every later slot with it. */
  const nextLongTaskStatusDueAt = (): number => {
    const gateAt = longTaskStatusGateAt();
    if (longTaskStatusPaintedAt < gateAt) {
      return gateAt;
    }
    const slotsUsed =
      Math.floor((longTaskStatusPaintedAt - gateAt) / LONG_TASK_STATUS_INTERVAL_MS) + 1;
    return gateAt + slotsUsed * LONG_TASK_STATUS_INTERVAL_MS;
  };

  const isLongTaskStatusDue = (now = Date.now()): boolean => now >= nextLongTaskStatusDueAt();

  const markLongTaskStatusPainted = (now = Date.now()): void => {
    longTaskStatusPaintedAt = now;
  };

  /** Claim the slot before sending, and hand it back only when the send is
   *  PROVEN not to have reached the user (846605/846608 — WeCom refused the
   *  frame). A missing ACK is not such proof: the gateway most likely rendered
   *  it, so releasing the slot there is what let the background lane repeat the
   *  very same status seconds later. */
  const claimLongTaskStatusSlot = (): (() => void) => {
    const previousPaintedAt = longTaskStatusPaintedAt;
    markLongTaskStatusPainted(Date.now());
    return () => {
      if (longTaskStatusPaintedAt !== previousPaintedAt) {
        longTaskStatusPaintedAt = previousPaintedAt;
      }
    };
  };

  const scheduleHeartbeat = (retryDelayMs?: number): void => {
    if (forceActivePushRequired()) {
      maybeSendPreviewExpiredNotice(true);
      return;
    }
    if (streamSettled || runtimeRetired || streamUpdateUnreliable || supersededByNewInbound) {
      return;
    }
    const elapsedMs = Date.now() - handleStartedAt;
    if (elapsedMs >= PREVIEW_WATCHDOG_MAX_MS) {
      return;
    }
    if (placeholderKeepalive) {
      if (retryDelayMs === undefined) {
        return;
      }
      clearTimeout(placeholderKeepalive);
      placeholderKeepalive = undefined;
    }
    // One shared schedule, so an unrelated frame can neither delay the next
    // status nor let a second lane sneak one in early.
    const delayMs = retryDelayMs ?? Math.max(0, nextLongTaskStatusDueAt() - Date.now());
    placeholderKeepalive = setTimeout(
      () => {
        placeholderKeepalive = undefined;
        const sent = sendPlaceholder();
        if (!previewFrozen) {
          scheduleHeartbeat(sent ? undefined : PLACEHOLDER_RETRY_MS);
        }
      },
      delayMs,
    );
    placeholderKeepalive.unref?.();
  };

  const startPlaceholder = (): void => {
    if (placeholderStarted) {
      return;
    }
    placeholderStarted = true;
    if (!ensureRuntimeCleanup()) {
      return;
    }
    if (params.autoSendPlaceholder === false || isEvent) {
      return;
    }
    if (forceActivePushRequired()) {
      maybeSendPreviewExpiredNotice(true);
      return;
    }
    sendPlaceholder();
    scheduleHeartbeat();

    // Register keepalive
    let keepalives = activeKeepalivesByScope.get(replyPeerKey);
    if (!keepalives) {
      keepalives = new Set();
      activeKeepalivesByScope.set(replyPeerKey, keepalives);
    }
    keepalives.add({ reqId, stop: stopPlaceholderKeepalive });
  };

  const activate = (): void => {
    if (activated) {
      return;
    }
    activated = true;
    if (!ensureRuntimeCleanup()) {
      return;
    }
    cancelPendingFinalRetryForNewActivation(replyPeerKey, activationId);
    startPlaceholder();
  };

  if (!params.deferActivation) {
    activate();
  }

  return {
    context: {
      transport: "bot-ws",
      accountId: params.accountId,
      reqId: params.frame.headers.req_id,
      raw: {
        transport: "bot-ws",
        command: params.frame.cmd,
        headers: params.frame.headers,
        body: params.frame.body,
        envelopeType: "ws",
      },
    },
    startPlaceholder,
    activate,
    onTransportRetired: (listener) => {
      if (!ensureRuntimeCleanup() || runtimeRetired) {
        listener();
        return () => {};
      }
      transportRetireListeners.add(listener);
      return () => {
        transportRetireListeners.delete(listener);
      };
    },
    markDispatchSettled: () => {
      dispatchSettled = true;
      maybeReleaseRuntimeCleanup();
    },
    deliver: async (payload: ReplyPayload, info) => {
      if (runtimeRetired || (!streamSettled && !ensureRuntimeCleanup())) {
        return;
      }
      refreshCallbackStreamOwnership();
      // Mark this chat as active on this handle
      notifyPeerActive();
      if (info.kind === "final") {
        clearPendingPreview();
      }

      if (
        info.kind === "final" &&
        payload.channelData?.wecomExternalFinalDelivered === true
      ) {
        // The answer is already visible in an active-push message. Finish only
        // the source stream and invalidate any older retry before it can
        // re-push partial text or rearm after an in-flight failure.
        obsoleteFinalRetry = true;
        finishPendingFinalRetry(false);
        finalDelivered = true;
        await closeOpenedStreamSilently(lastPreviewText);
        return;
      }

      if (
        info.kind === "final" &&
        supersededByNewInbound &&
        payload.isError === true &&
        // Failure copy only. A superseded final that still carries an artifact
        // keeps the normal superseded path, which uploads it and explains why.
        !payload.mediaUrl &&
        (payload.mediaUrls?.length ?? 0) === 0 &&
        deferredMediaUrls.length === 0
      ) {
        // The user replaced this turn themselves, and handing the session over
        // is what ends the old run — pushing the core's failure copy for it
        // lands an unexplained "Something went wrong" next to the new answer.
        settleStream();
        console.info(
          `[wecom-b3] superseded-final-skip-error account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} supersededAt=${supersededAt ?? 0}`,
        );
        return;
      }

      const transientProgressKind = payload.channelData?.openclawProgressKind;
      if (transientProgressKind === "preamble" || transientProgressKind === "fast-mode-auto") {
        const progressText = payload.text?.trim() ?? "";
        if (!progressText || isEvent || supersededByNewInbound || streamSettled) {
          return;
        }
        const transientProgressText = rememberTransientProgress(
          transientProgressKind,
          progressText,
        );
        if (await sendForcedTransientProgress(transientProgressText)) {
          return;
        }
        const thinkingLimits = resolveThinkingAwareBodyLimits(accumulatedThinkingText);
        const progress = composePreviewSuffixWithinLimits({
          prefix: accumulatedText,
          suffix: transientProgressText,
          separator: "\n",
          maxChars: thinkingLimits.maxChars,
          maxBytes: thinkingLimits.maxBytes,
        });
        const progressPreviewText = prependThinkingToPreviewWire(progress.text);
        if (!progressPreviewText || progressPreviewText === lastPreviewText) {
          return;
        }
        // OpenClaw progress is visible process feedback, not answer text.
        // Rendering it through the preview lane keeps it out of accumulatedText
        // and final.
        await sendPreviewUpdate(progressPreviewText, Date.now(), {
          bodySourceText: progress.visiblePrefix,
          showsVisibleBody: Boolean(progress.visiblePrefix),
          transientProgressText: progress.visibleSuffix,
        });
        return;
      }

      if (payload.isReasoning) {
        const thinkingText = payload.text?.trim() || "";
        if (isEvent || supersededByNewInbound || streamSettled || !thinkingText) {
          return;
        }
        accumulatedThinkingText = mergeReplyText(accumulatedThinkingText, thinkingText);
        await sendThinkingSnapshot();
        return;
      }

      const rawText = payload.text?.trim() || "";
      const extracted = extractInlineThinkBlocks(rawText);
      if (extracted.thinkingText && !isEvent && !supersededByNewInbound && !streamSettled) {
        accumulatedThinkingText = mergeReplyText(accumulatedThinkingText, extracted.thinkingText);
        if (info.kind === "final") {
          await sendThinkingSnapshot({ force: true });
        }
      }
      const text = extracted.bodyText;
      const incomingMediaUrls = payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []);
      const hasIncomingMedia = incomingMediaUrls.length > 0;
      if (info.kind !== "final" && hasIncomingMedia) {
        mergeDeferredMediaUrls(incomingMediaUrls);
      }
      const mediaUrls =
        info.kind === "final" ? mergeDeferredMediaUrls(incomingMediaUrls) : incomingMediaUrls;
      if (info.kind !== "final" && !text && mediaUrls.length === 0) {
        return;
      }

      if (info.kind === "block") {
        if (!text) {
          return;
        }
        accumulatedText = mergeReplyText(accumulatedText, text);
        await deliverBlockPreview(accumulatedText);
        return;
      }

      if (info.kind === "final" && supersededByNewInbound && suppressSupersededFinalPush) {
        settleStream();
        console.info(
          `[wecom-b3] superseded-final-skip-visible account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} supersededAt=${supersededAt ?? 0}`,
        );
        return;
      }

      const outboundText =
        info.kind === "final"
          ? mergeFinalReplyText(accumulatedText, text)
          : accumulatedText || text;

      let finalText = outboundText;
      let finalAppendCompletionMarker = false;
      let finalMediaDelivered = false;
      let currentFinalDeliveryKey = "";
      let currentFinalUsesPeerDedup =
        info.kind === "final" && !supersededByNewInbound && !forceActivePushRequired();
      if (info.kind === "final" && mediaUrls.length > 0) {
        const cfg = getWecomRuntime().config.loadConfig();
        const mediaLocalRoots = resolveWecomMergedMediaLocalRoots({ cfg });
        const mediaMaxBytes = resolveWecomMediaMaxBytes(cfg, params.accountId);
        currentFinalDeliveryKey = buildFinalDeliveryKey({
          accountId: params.accountId,
          peerKind,
          peerId: peerKeyId,
          reqId: finalDeliveryReqId,
          text: outboundText,
          mediaUrls,
        });
        currentFinalUsesPeerDedup =
          !supersededByNewInbound && !forceActivePushRequired();
        if (
          !markFinalDelivered(currentFinalDeliveryKey, {
            peerDedup: currentFinalUsesPeerDedup,
          })
        ) {
          return;
        }
        const mediaFailures: string[] = [];
        const mediaNotes: string[] = [];
        let mediaSent = 0;
        for (const mediaUrl of mediaUrls) {
          if (runtimeRetired) {
            return;
          }
          const result = await uploadAndSendBotWsMedia({
            wsClient: params.client,
            chatId: peerId,
            mediaUrl,
            mediaLocalRoots,
            maxBytes: mediaMaxBytes,
          });
          if (result.ok) {
            mediaSent += 1;
            finalMediaDelivered = true;
            visibleReplyStarted = true;
            if (result.downgradeNote) {
              mediaNotes.push(result.downgradeNote);
            }
            if (supersededByNewInbound) {
              suppressSupersededFinalPush = true;
              obsoleteFinalRetry = true;
              break;
            }
            continue;
          }
          mediaFailures.push(formatMediaFailure(mediaUrl, result.error, result.rejectReason));
        }

        if (supersededByNewInbound && suppressSupersededFinalPush) {
          deferredMediaUrls = [];
          settleStream();
          console.info(
            `[wecom-b3] superseded-final-stop-after-media account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
          );
          params.onDeliver?.();
          return;
        }

        if (!finalText && mediaSent > 0) {
          finalText = "文件已发送。";
        }
        if (mediaFailures.length > 0) {
          finalText = finalText
            ? `${finalText}\n\n${mediaFailures.join("\n")}`
            : mediaFailures.join("\n");
        }
        if (mediaNotes.length > 0) {
          finalText = finalText
            ? `${finalText}\n\n${mediaNotes.join("\n")}`
            : mediaNotes.join("\n");
        }
        deferredMediaUrls = [];
      }
      if (info.kind === "final" && payload.isError === true) {
        // OpenClaw genericises unclassifiable provider errors ("LLM request
        // failed.") and drops the raw text before it ever reaches a channel, so
        // this line is what lets a report be correlated with the gateway's own
        // `embedded run agent end … rawError=…` entry.
        const forcedActivePush = forceActivePushRequired();
        console.warn(
          `[wecom-reply] error-final account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} elapsedMs=${Date.now() - handleStartedAt} bodyChars=${accumulatedText.length} thinkingChars=${accumulatedThinkingText.length} streamDead=${String(streamUpdateUnreliable && !forcedActivePush)} forcedPush=${String(forcedActivePush)} ackUntrusted=${String(streamAckUnreliable)} text=${JSON.stringify(finalText.slice(0, 200))}`,
        );
      }
      if (info.kind === "final") {
        const reasoningOnlyFinal = !finalText && !!accumulatedThinkingText;
        finalText = dedupeLongFinalText(finalText, { previewFrozen });
        finalAppendCompletionMarker =
          payload.isError !== true &&
          !isEvent &&
          shouldAppendStreamCompletionMarker({
            finalText,
            previewFrozen,
            reasoningOnly: reasoningOnlyFinal,
          });
        if (!isEvent) {
          // A superseded reasoning-only handle must stay silent: promoting
          // the marker here would actively push a stray "（回复完毕）" bubble
          // into the newer conversation.
          if (!finalText && reasoningOnlyFinal && !supersededByNewInbound) {
            finalText = FINAL_COMPLETION_MARKER;
          }
        }
      }
      if (!finalText) {
        if (info.kind === "final") {
          // Close on the last text the user actually saw: a WeCom stream frame
          // replaces the whole bubble, so finishing with "" blanks it.
          await closeOpenedStreamSilently(lastPreviewText);
        }
        return;
      }

      if (info.kind === "final" && !currentFinalDeliveryKey) {
        currentFinalUsesPeerDedup =
          !supersededByNewInbound && !forceActivePushRequired();
        currentFinalDeliveryKey = buildFinalDeliveryKey({
          accountId: params.accountId,
          peerKind,
          peerId: peerKeyId,
          reqId: finalDeliveryReqId,
          text: finalText,
          mediaUrls,
        });
        if (!markFinalDelivered(currentFinalDeliveryKey, { peerDedup: currentFinalUsesPeerDedup })) {
          return;
        }
      }

      // Event frames do not support streaming chunks
      if (isEvent && info.kind !== "final") {
        return;
      }

      try {
        if (params.inboundKind === "welcome" && !forceActivePushRequired()) {
          settleStream();
          await withHandleSendTimeout(
            params.client.replyWelcome(params.frame, {
              msgtype: "text",
              text: { content: finalText },
            }),
            "welcome reply",
          );
        } else if (isEvent) {
          settleStream();
          // Send push message for other events
          await withHandleSendTimeout(
            params.client.sendMessage(peerId, {
              msgtype: "markdown",
              markdown: { content: toWeComMarkdownV2(finalText) },
            }),
            "event markdown push",
          );
        } else if (info.kind === "final" && supersededByNewInbound) {
          settleStream();
          const fallbackText = resolveStreamFallbackText(finalText, payload.isError === true);
          const textToSend =
            mediaUrls.length > 0
              ? `${fallbackText}\n\n${B3_MEDIA_SUPERSEDED_NOTE}`
              : fallbackText;
          console.info(
            `[wecom-b3] superseded-final account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} supersededAt=${supersededAt ?? 0}`,
          );
          try {
            await sendMarkdownChunksViaActivePush(textToSend, {
              reason: "superseded-final",
              appendCompletionMarker: finalAppendCompletionMarker,
              progress: resolveFinalPushProgress(textToSend, finalAppendCompletionMarker),
            });
          } catch (error) {
            if (isAmbiguousActivePushDeliveryError(error)) {
              // A wholly invisible superseded final keeps its bounded retry;
              // dropping it here would silently lose the old run's answer.
              params.onFail?.(error);
              scheduleFinalPushRetry({
                text: textToSend,
                deliveryKey: currentFinalDeliveryKey,
                peerDedup: currentFinalUsesPeerDedup,
                appendCompletionMarker: finalAppendCompletionMarker,
                alreadyMarkedDelivered: true,
                preserveDeliveryClaim: true,
              });
              return;
            }
            rollbackFinalDelivered(currentFinalDeliveryKey, {
              peerDedup: currentFinalUsesPeerDedup,
            });
            scheduleFinalPushRetry({
              text: textToSend,
              deliveryKey: currentFinalDeliveryKey,
              peerDedup: currentFinalUsesPeerDedup,
              appendCompletionMarker: finalAppendCompletionMarker,
            });
            throw error;
          }
        } else if (info.kind === "final") {
          settleStream();
          const normalFinalResult = await deliverNormalFinalViaStream(finalText, {
            appendCompletionMarker: finalAppendCompletionMarker,
            deliveryKey: currentFinalDeliveryKey,
            peerDedup: currentFinalUsesPeerDedup,
            isError: payload.isError === true,
          });
          if (normalFinalResult === "retry-scheduled") {
            return;
          }
          if (!normalFinalResult) {
            if (!finalMediaDelivered) {
              rollbackFinalDelivered(currentFinalDeliveryKey, {
                peerDedup: currentFinalUsesPeerDedup,
              });
            }
            if (!(supersededByNewInbound && suppressSupersededFinalPush)) {
              scheduleFinalPushRetry({
                text: resolveStreamFallbackText(finalText, payload.isError === true),
                deliveryKey: currentFinalDeliveryKey,
                peerDedup: currentFinalUsesPeerDedup,
                appendCompletionMarker: payload.isError !== true,
                alreadyMarkedDelivered: finalMediaDelivered,
                preserveDeliveryClaim: finalMediaDelivered,
              });
            }
            return;
          }
        } else {
          stopPlaceholderKeepalive();
          visibleReplyStarted = true;
          if (forceActivePushRequired()) {
            await sendMarkdownChunksViaActivePush(finalText, { reason: "forced-progress" });
          } else {
            await withHandleSendTimeout(
              sendNonFinalStreamUpdate({
                client: params.client,
                frame: params.frame,
                streamId: resolveStreamId(),
                content: renderPreviewFrame(finalText).text,
              }),
              "direct block stream",
            );
          }
        }
      } catch (error) {
        if (isTerminalReplyError(error)) {
          params.onFail?.(error);
          return;
        }
        throw error;
      }
      params.onDeliver?.();
    },
    fail: async (error: unknown) => {
      if (runtimeRetired || (!streamSettled && !ensureRuntimeCleanup())) {
        return;
      }
      refreshCallbackStreamOwnership();
      notifyPeerActive();
      settleStream();
      if (supersededByNewInbound) {
        // A superseded handle must not touch the old stream again — sending
        // the error text would finish (or revive) the old bubble.
        console.info(
          `[wecom-b3] fail-skip-superseded account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
        );
        params.onFail?.(error);
        return;
      }
      const message = formatErrorMessage(error);
      const noVisibleOutput = isReplyNoVisibleOutputError(error, message);
      const modelTimeout = isOpenClawModelTimeoutError(error, message);
      const prepareTimeout = isPrepareTimeoutError(error, message);
      const initConflict = isRetryableReplySessionAdmissionError(error);
      // Only append the notice to previews that carried visible body text,
      // and rebuild the progress from the body-only source: lastPreviewText
      // can embed the <think> block, whose wrapper the markdown sanitizer
      // strips — promoting raw reasoning summaries to visible text.
      const failNoticeText = initConflict
        ? REPLY_SESSION_INIT_CONFLICT_NOTICE_TEXT
        : prepareTimeout
          ? REPLY_PREPARE_TIMEOUT_NOTICE_TEXT
          : modelTimeout
            ? REPLY_MODEL_TIMEOUT_NOTICE_TEXT
            : noVisibleOutput && lastPreviewText && accumulatedText
              ? appendFailureNoticeToProgress(accumulatedText, REPLY_FAIL_NOTICE_TEXT)
              : REPLY_FAIL_NOTICE_TEXT;
      const text = initConflict || prepareTimeout || modelTimeout || noVisibleOutput
        ? failNoticeText
        : `WeCom WS reply failed: ${message}`;
      const sendFailNoticeOnce = async (): Promise<void> => {
        if (isEvent || finalDelivered || finalPushRetryTimer || failNoticeSent) {
          return;
        }
        failNoticeSent = true;
        console.warn(
          `[wecom-reply] fail-notice account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
        );
        try {
          await sendMarkdownChunksViaActivePush(failNoticeText, {
            reason: "fail-notice",
          });
        } catch (pushError) {
          console.warn(
            `[wecom-reply] fail-notice-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(pushError)}`,
          );
        }
      };

      if (isTerminalReplyError(error)) {
        // The stream channel is dead; without an active push the user would
        // get total silence. Push a one-time failure notice unless a final
        // was delivered or a final push retry is still pending.
        await sendFailNoticeOnce();
        params.onFail?.(error);
        return;
      }
      if (!isEvent && params.inboundKind !== "welcome" && streamDeliveryUntrusted()) {
        // The stream already died terminally (e.g. 846608); writing the error
        // text to it is guaranteed to fail and would leave the user with a
        // broken "完成后将以新消息发送" promise. Route through active push.
        await sendFailNoticeOnce();
        params.onFail?.(error);
        return;
      }
      if (!isEvent && params.inboundKind !== "welcome") {
        const pendingAckCleared = await waitForPendingReplyAckToClear({
          client: params.client,
          frame: params.frame,
          hasLocalPendingReply: () => placeholderInFlight || previewInFlightCount > 0,
        });
        if (runtimeRetired) {
          return;
        }
        if (supersededByNewInbound) {
          params.onFail?.(error);
          return;
        }
        if (!pendingAckCleared || streamDeliveryUntrusted()) {
          await sendFailNoticeOnce();
          params.onFail?.(error);
          return;
        }
      }
      try {
        if (params.inboundKind === "welcome" && !forceActivePushRequired()) {
          await withHandleSendTimeout(
            params.client.replyWelcome(params.frame, {
              msgtype: "text",
              text: { content: text },
            }),
            "welcome error reply",
          );
        } else if (isEvent) {
          await withHandleSendTimeout(
            params.client.sendMessage(peerId, {
              msgtype: "markdown",
              markdown: { content: text },
            }),
            "event error markdown push",
          );
        } else {
          visibleReplyStarted = true;
          await withHandleSendTimeout(
            params.client.replyStream(params.frame, resolveStreamId(), text, true),
            "stream error reply",
          );
        }
      } catch (sendError) {
        params.onFail?.(sendError);
        return;
      }
      params.onFail?.(error);
    },
    markExternalActivity: () => {
      notifyPeerActive();
      clearPendingPreview();
      // Defer our own cadence by one interval so it does not pile onto the
      // message that just arrived — but never retire it: the turn is still
      // running, and this handle owns its only progress feedback.
      if (placeholderKeepalive) {
        clearTimeout(placeholderKeepalive);
        placeholderKeepalive = undefined;
      }
      scheduleHeartbeat();
      deferPreviewExpiredNotice();
    },
    supersedeByNewInbound: (meta) => {
      if (
        meta.accountId !== params.accountId ||
        meta.peerKind !== peerKind ||
        normalizePeerKey(meta.peerId) !== peerKeyId
      ) {
        return;
      }
      if (supersededByNewInbound) {
        return;
      }
      supersededByNewInbound = true;
      if (meta.reason === "new-inbound-unmerged") {
        supersededNoticeText = B3_SUPERSEDED_UNMERGED_NOTICE_TEXT;
      }
      suppressSupersededFinalPush = visibleReplyStarted;
      if (suppressSupersededFinalPush) {
        obsoleteFinalRetry = true;
      }
      supersededAt = Date.now();
      clearPendingPreview();
      stopPlaceholderKeepalive();
      stopPreviewFreezeTimeout();
      stopPreviewStatusInterval();
      cancelPreviewExpiredNotice();
      // Confirmed visible old replies must not revive. A wholly invisible
      // final keeps its bounded retry so the result is not lost permanently.
      if (suppressSupersededFinalPush) {
        finishPendingFinalRetry(true);
      }
      console.info(
        `[wecom-b3] superseded account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} reason=${meta.reason} pendingAck=${hasPendingReplyAck(params.client, params.frame)}`,
      );
      closeSupersededPlaceholder();
    },
  };
}
