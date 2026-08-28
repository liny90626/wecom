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
import {
  containsTemplateCardBlock,
  extractTemplateCards,
  maskTemplateCardBlocks,
} from "../../capability/card/parser.js";
import { sendTemplateCards } from "../../capability/card/manager.js";
import { uploadAndSendBotWsMedia } from "./media.js";

const PLACEHOLDER_RETRY_MS = 3000;
const LONG_TASK_STATUS_AFTER_MS = 8 * 60_000;
const B2_PEER_FINAL_DEDUP_TTL_MS = 120_000;
const WECOM_STREAM_MAX_CHARS = 3_500;
/**
 * WeCom documents a 20 480-byte ceiling for a stream frame's `content`. The old
 * 2 000-char / 12 000-byte pair predates that number and was chosen blind ("避免
 * 盲目放宽限制引入客户端截断"), leaving half the allowance unused and splitting a
 * 6 000-char answer into four messages. Both now sit near 75 % of the documented
 * ceiling: 5 000 Chinese chars is 15 000 bytes, just inside the byte cap.
 */
const WECOM_STREAM_FINAL_MAX_CHARS = 5_000;
const WECOM_STREAM_MAX_BYTES = 15_360;
const BLOCK_PREVIEW_MAX_MS = 300_000;
const BLOCK_PREVIEW_MAX_CHARS = 3_000;
const BLOCK_PREVIEW_MIN_UPDATE_MS = 1_500;
/** How often the long-task status line may repaint, on ANY lane. */
const LONG_TASK_STATUS_INTERVAL_MS = 60_000;
const THINKING_PREVIEW_MIN_UPDATE_MS = 3_000;
/**
 * How long the bubble may sit unchanged once the run has moved into tool work.
 * Reasoning ends, tools run for minutes, and nothing repaints: the heartbeat is
 * scheduled straight to the 8-minute gate, so the turn LOOKS hung well before
 * it is a long task. This is the liveness clock; the long-task copy still waits
 * for its absolute threshold.
 */
const PREVIEW_SILENCE_MAX_MS = 90_000;
const WECOM_REPLY_SEND_TIMEOUT_MS = 8_000;
const WECOM_PENDING_ACK_GRACE_MS = 5_500;
const WECOM_PENDING_ACK_POLL_MS = 100;
const THINKING_BLOCK_MAX_CHARS = 3_000;
const THINKING_BLOCK_MAX_BYTES = 8_000;
/**
 * The thinking block and the answer share ONE frame budget, so an ample block
 * cuts the visible answer down to a sliver — 3 000 chars of reasoning used to
 * leave the body 484. Once there is an answer on screen the block yields to it,
 * the same rule the process log follows.
 */
const THINKING_BLOCK_WITH_BODY_MAX_CHARS = 800;
const THINKING_BLOCK_WITH_BODY_MAX_BYTES = 2_400;
/** Shown when the block holds only the newest slice of a long reasoning run. */
const THINKING_ELISION_MARKER = "…（较早的思考已省略）\n";
/** `<think></think>` plus its trailing newline costs around the content. */
const THINK_BLOCK_WRAPPER_CHARS = 16;
const THINK_BLOCK_WRAPPER_BYTES = 16;
const LONG_FINAL_DEDUP_MIN_CHARS = 3_000;
const LONG_FINAL_DEDUP_MIN_SEGMENT_CHARS = 120;
const STRUCTURED_TAIL_MIN_DUPLICATE_LINES = 4;
const FINAL_COMPLETION_MARKER = "（回复完毕）";
const LONG_TASK_STATUS_PREFIX = "【长任务处理中，请勿打断，已用时";
/** Before the long-task threshold "still working" must not ask the user to
 *  change their behaviour — a 90-second turn is not a long task. */
const RUN_ALIVE_STATUS_PREFIX = "【处理中，已用时";
const PREVIEW_WATCHDOG_MAX_MS = 60 * 60 * 1000;
const PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS = LONG_TASK_STATUS_AFTER_MS;
/** With answer text on screen the log tail yields the bubble to the answer. */
const PROCESS_LOG_TAIL_WITH_BODY_MAX_CHARS = 800;
/**
 * A push carrying new steps earns its slot on the shared 60 s grid. A push with
 * nothing new to say is just the clock, so it waits out this much silence
 * first: it exists to prove a silent turn is alive (禁改 25), not to tick.
 */
const LONG_TASK_QUIET_STATUS_INTERVAL_MS = 5 * 60_000;
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

function formatElapsedStatus(elapsedMs: number, longTask = true): string {
  const prefix = longTask ? LONG_TASK_STATUS_PREFIX : RUN_ALIVE_STATUS_PREFIX;
  return `${prefix}${formatElapsedDuration(elapsedMs)}】`;
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

/**
 * Reasoning was the one text that reached the wire without the body's Markdown
 * normalization: it only had same-line `<…>` pairs removed. A bare `<` (`if (a
 * < b)`, `Map<string`, an XML snippet) then survives, and because the block is
 * always closed with `</think>`, the client consumes `< … </think>` as one tag
 * — the block never closes and swallows the answer behind it. That is the
 * "bubble shows only the thinking block, no answer" report.
 *
 * So normalize with the body's own pipeline, then neutralize whatever could
 * still open a tag. Escaping expands the text, so it must happen before the
 * budget is applied (禁改 32), which is exactly where this runs.
 */
function escapeThinkBlockText(text: string): string {
  return toWeComMarkdownV2(text, null).replace(/</g, "&lt;").trim();
}

/** The block is cut on both ends, so the tail can hold half an entity and
 *  either end half a code fence. Any ``` still standing after normalization is
 *  unpaired by construction — paired ones were converted away — and an unpaired
 *  fence swallows the closing tag exactly like an unpaired tag did. */
function stripDanglingThinkMarkup(text: string): string {
  return text
    .replace(/&[a-zA-Z#0-9]{0,6}$/, "")
    .replaceAll("```", "")
    .trim();
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

function sliceUtf16SafeSuffix(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) {
    return value;
  }
  let start = value.length - Math.max(0, maxCodeUnits);
  const previous = value.charCodeAt(start - 1);
  const first = value.charCodeAt(start);
  if (previous >= 0xd800 && previous <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) {
    start += 1;
  }
  return value.slice(start);
}

function trimToUtf8BytesFromEnd(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const chars = [...value];
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const size = Buffer.byteLength(chars[start - 1]!, "utf8");
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    start -= 1;
  }
  return chars.slice(start).join("");
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

/**
 * Renders the NEWEST slice of the reasoning. A head-truncated block stops
 * changing the moment the reasoning passes the cap, and an unchanged frame is
 * dropped as a duplicate — which is how a long thinking block silenced the
 * whole preview lane and left the bubble frozen at "a certain length". The tail
 * is also the useful half: it is what the model is working through now.
 *
 * Normalizing only the window that can possibly fit keeps this O(budget) on a
 * stream that grows without bound; the 4x window leaves the normalizer room to
 * shrink the text and still fill the budget.
 */
function renderThinkContent(
  text: string,
  maxBytes = THINKING_BLOCK_MAX_BYTES,
  maxChars = THINKING_BLOCK_MAX_CHARS,
): string {
  const charBudget = Math.min(THINKING_BLOCK_MAX_CHARS, Math.max(0, maxChars));
  const byteBudget = Math.min(THINKING_BLOCK_MAX_BYTES, maxBytes);
  const source = text || "progress";
  const window = sliceUtf16SafeSuffix(source, Math.max(charBudget * 4, 1_000));
  const normalized = escapeThinkBlockText(window);
  const fitTail = (chars: number, bytes: number): string =>
    stripDanglingThinkMarkup(
      trimToUtf8BytesFromEnd(
        sliceUtf16SafeSuffix(normalized, Math.max(0, chars)),
        Math.max(0, bytes),
      ),
    );
  if (
    window.length >= source.length &&
    normalized.length <= charBudget &&
    Buffer.byteLength(normalized, "utf8") <= byteBudget
  ) {
    return fitTail(charBudget, byteBudget);
  }
  const content = fitTail(
    charBudget - THINKING_ELISION_MARKER.length,
    byteBudget - Buffer.byteLength(THINKING_ELISION_MARKER, "utf8"),
  );
  return content ? `${THINKING_ELISION_MARKER}${content}` : "";
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

/**
 * How one preview frame is divided between the reasoning block and the answer.
 * Both halves come from the same call on purpose: when the rendered block and
 * the body budget were computed separately they could disagree, and the frame
 * that went out was the sum of two different assumptions.
 */
function resolveThinkingFrameLayout(
  thinkingText: string,
  hasBody: boolean,
): { block: string; maxChars: number; maxBytes: number } {
  const block = renderInlineThinkBlock(
    thinkingText,
    hasBody ? THINKING_BLOCK_WITH_BODY_MAX_BYTES : THINKING_BLOCK_MAX_BYTES,
    hasBody ? THINKING_BLOCK_WITH_BODY_MAX_CHARS : THINKING_BLOCK_MAX_CHARS,
  );
  if (!block) {
    return { block: "", maxChars: WECOM_STREAM_MAX_CHARS, maxBytes: WECOM_STREAM_MAX_BYTES };
  }
  const prefix = `${block}\n`;
  return {
    block,
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
  let deferredMediaUrls: string[] = [];

  // ---- Process log --------------------------------------------------------
  // The run's narration is a record, not a status: the orchestrator sends the
  // whole step log, the bubble paints its tail as a pure display, and the push
  // lanes persist it. Steps are addressed in ABSOLUTE indices (dropped + array
  // index). ONE durable prefix — the steps that survive this turn — advanced by
  // the two things that prove survival: a confirmed push, and the moment WeCom
  // retires the stream window, which freezes the bubble's own confirmed frame
  // into a permanent chat message. `processLogBubble` is that pending frame's
  // prefix, never a second delivery lane: it only ever folds into the durable
  // one, and only while it stays contiguous with it.
  let processLogSteps: string[] = [];
  let processLogDroppedStepCount = 0;
  const processLogDurable = { count: 0, lastText: "" };
  const processLogBubble = { count: 0, lastText: "" };
  let transientFastModeText = "";
  let pushedFastModeText = "";

  const processLogTotalStepCount = (): number =>
    processLogDroppedStepCount + processLogSteps.length;

  const processLogStepAt = (absoluteIndex: number): string | undefined =>
    processLogSteps[absoluteIndex - processLogDroppedStepCount];

  // Full-width paren on purpose: "1）" is not markdown list syntax, so WeCom
  // cannot renumber a tail that starts mid-log the way "1." lists are.
  const formatProcessLogStep = (absoluteIndex: number, text: string): string =>
    `${absoluteIndex + 1}）${text}`;

  const clampProcessLogBookmark = (
    bookmark: { count: number; lastText: string },
    steps: string[],
    droppedStepCount: number,
  ): void => {
    let count = Math.min(bookmark.count, droppedStepCount + steps.length);
    while (count > droppedStepCount) {
      const currentText = steps[count - 1 - droppedStepCount];
      const deliveredText =
        count === bookmark.count ? bookmark.lastText : processLogStepAt(count - 1);
      if (currentText !== undefined && currentText === deliveredText) {
        break;
      }
      count -= 1;
    }
    bookmark.count = Math.max(count, Math.min(bookmark.count, droppedStepCount));
    bookmark.lastText =
      bookmark.count > droppedStepCount
        ? (steps[bookmark.count - 1 - droppedStepCount] ?? "")
        : "";
  };

  const advanceProcessLogBookmark = (
    bookmark: { count: number; lastText: string },
    absoluteCount: number,
    lastText: string,
  ): void => {
    if (absoluteCount <= bookmark.count) {
      return;
    }
    bookmark.count = Math.min(absoluteCount, processLogTotalStepCount());
    bookmark.lastText = lastText;
  };

  const adoptProcessLogSteps = (steps: string[], droppedStepCount: number): void => {
    // A mutated or replaced step becomes deliverable again; settled history
    // (only the tail can change in the real pipeline) stays settled.
    clampProcessLogBookmark(processLogDurable, steps, droppedStepCount);
    clampProcessLogBookmark(processLogBubble, steps, droppedStepCount);
    processLogSteps = steps.slice();
    processLogDroppedStepCount = droppedStepCount;
  };

  const composeProcessLogLines = (fromAbsolute: number): string[] => {
    const lines: string[] = [];
    for (
      let i = Math.max(fromAbsolute, processLogDroppedStepCount);
      i < processLogTotalStepCount();
      i += 1
    ) {
      const text = processLogStepAt(i);
      if (text) {
        lines.push(formatProcessLogStep(i, text));
      }
    }
    return lines;
  };

  /**
   * Newest steps first-fit within BOTH budgets, oldest first in the output.
   * Sizing by bytes as well matters: the wire composer trims an oversized
   * suffix from its tail, which for a log means losing the newest step (or a
   * trailing status line) instead of the oldest.
   */
  /** What the last composed tail view actually showed, so a frame confirmed on
   *  the wire can report the steps the bubble now holds. */
  let lastProcessLogViewRange: { from: number; to: number; lastText: string } | undefined;

  const composeProcessLogTailView = (maxChars: number, maxBytes: number): string => {
    lastProcessLogViewRange = undefined;
    if (!processLogSteps.length || maxChars <= 0 || maxBytes <= 0) {
      return "";
    }
    const lines: string[] = [];
    let usedChars = 0;
    let usedBytes = 0;
    let firstShown = processLogTotalStepCount();
    for (let i = processLogTotalStepCount() - 1; i >= processLogDroppedStepCount; i -= 1) {
      const text = processLogStepAt(i);
      if (!text) {
        continue;
      }
      const line = formatProcessLogStep(i, text);
      const separator = lines.length ? 1 : 0;
      const costChars = line.length + separator;
      const costBytes = Buffer.byteLength(line, "utf8") + separator;
      if (lines.length && (usedChars + costChars > maxChars || usedBytes + costBytes > maxBytes)) {
        break;
      }
      lines.unshift(line);
      usedChars += costChars;
      usedBytes += costBytes;
      firstShown = i;
      if (usedChars >= maxChars || usedBytes >= maxBytes) {
        break;
      }
    }
    if (lines.length > 0) {
      lastProcessLogViewRange = {
        from: firstShown,
        to: processLogTotalStepCount(),
        lastText: processLogSteps.at(-1) ?? "",
      };
    }
    if (firstShown > 0) {
      lines.unshift(`…（已省略前 ${firstShown} 步）`);
    }
    return lines.join("\n");
  };

  const composeTransientPreviewSuffix = (logMaxChars: number, logMaxBytes: number): string =>
    [composeProcessLogTailView(logMaxChars, logMaxBytes), transientFastModeText]
      .filter(Boolean)
      .join("\n\n");
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
    /** The step range this frame puts on screen, reported once it is confirmed. */
    processLogShown?: { from: number; to: number; lastText: string };
  };
  type PendingPreview = {
    text: string;
    bodySourceText?: PreviewDeliveryMetadata["bodySourceText"];
    showsVisibleBody?: PreviewDeliveryMetadata["showsVisibleBody"];
    processLogShown?: PreviewDeliveryMetadata["processLogShown"];
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
    const layout = resolveThinkingFrameLayout(accumulatedThinkingText, Boolean(accumulatedText));
    const thinkingBlock = layout.block;
    const bodyLimits = { maxChars: layout.maxChars, maxBytes: layout.maxBytes };
    const statusText = formatElapsedStatus(
      elapsedMs,
      elapsedMs >= LONG_TASK_STATUS_AFTER_MS,
    );
    // The status line is this frame's whole purpose (禁改 25) — reserve its
    // budget up front so an ample log can never squeeze it off the wire.
    const statusReserveChars = statusText.length + 2;
    const statusReserveBytes = Buffer.byteLength(statusText, "utf8") + 2;
    const transientView = composeTransientPreviewSuffix(
      (accumulatedText ? PROCESS_LOG_TAIL_WITH_BODY_MAX_CHARS : bodyLimits.maxChars) -
        statusReserveChars,
      bodyLimits.maxBytes - statusReserveBytes,
    );
    const statusSuffix = [transientView, statusText].filter(Boolean).join("\n\n");
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
    const bubbleIsStale = elapsedMs >= 0 && Date.now() >= bubbleSilenceDueAt();
    if (
      lastPreviewText &&
      !bubbleIsStale &&
      (elapsedMs < LONG_TASK_STATUS_AFTER_MS || previewFrozen)
    ) {
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
    // The static placeholder is only right for a bubble that has never shown
    // anything. Repainting a stale one with it would wipe the reasoning and the
    // step log off the screen, so that case renders the full frame plus clock.
    const showsLongTaskStatus = elapsedMs >= LONG_TASK_STATUS_AFTER_MS;
    const heartbeatText =
      showsLongTaskStatus || bubbleIsStale
        ? renderLongTaskHeartbeat(elapsedMs)
        : placeholderText;
    const releaseLongTaskStatusSlot =
      showsLongTaskStatus || bubbleIsStale ? claimLongTaskStatusSlot() : undefined;
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
        retireBubbleForDeadWindow(true);
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
  /** This handle has already pushed its template cards; they cannot be recalled. */
  let templateCardsDispatched = false;
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
  /** Set when the bubble stops being repaintable: from then on the push lane is
   *  the only channel, so the shared grid starts there instead of at 8 minutes. */
  let longTaskStatusGateOverrideAt: number | undefined;
  /** Set once the run reports tool work (禁改 35: evidence only, never content). */
  let toolActivityObserved = false;
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
            chat_type: peerKind === "group" ? 2 : 1,
          } as Parameters<typeof params.client.sendMessage>[1]),
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
        await withHandleSendTimeout(
          pushHandle.sendMarkdown(peerId, chunk, peerKind),
          "active markdown push",
        );
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
      /** OpenClaw deferred this turn's answer to a later run. */
      deferred: boolean;
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
    // A pushed message has no bubble context, so it normally carries the marker
    // to show the answer ended there. A deferred turn has NOT ended: the marker
    // would tell the user to stop waiting for the answer that is still coming.
    const fallbackAppendCompletionMarker = !options.isError && !options.deferred;
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

  const renderPreviewFrame = (
    rawSourceText: string,
    now = Date.now(),
  ): { text: string; bodySourceText?: string } => {
    // A template card is JSON the user must never see. It is only sendable once
    // the block closes, so every intermediate frame — body preview, frozen
    // status, timeout freeze — renders the placeholder instead. Masking here
    // rather than at one call site keeps every preview lane consistent.
    const sourceText = containsTemplateCardBlock(rawSourceText)
      ? maskTemplateCardBlocks(rawSourceText)
      : rawSourceText;
    const thinkingLimits = resolveThinkingFrameLayout(
      accumulatedThinkingText,
      Boolean(sourceText),
    );
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
      text: thinkingLimits.block
        ? `${thinkingLimits.block}\n${bodyPreview.text}`
        : bodyPreview.text,
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
    // The bubble is unrepaintable but the agent keeps producing: carry whatever
    // the user has not seen out with the status line instead of dropping it.
    // Reasoning stays out — only the visible body travels this way.
    const progressSnapshot = accumulatedText;
    const undeliveredProgress = resolveUndeliveredProgressText(progressSnapshot);
    const logTotalAtCompose = processLogTotalStepCount();
    const logLastTextAtCompose = processLogSteps.at(-1) ?? "";
    const undeliveredTransientProgress = composeProcessLogLines(
      processLogDurable.count,
    ).join("\n");
    const undeliveredFastText =
      transientFastModeText && transientFastModeText !== pushedFastModeText
        ? transientFastModeText
        : "";
    const now = Date.now();
    const hasNewContent = Boolean(
      undeliveredProgress || undeliveredTransientProgress || undeliveredFastText,
    );
    // New content earns its slot on the shared grid, and once the window is
    // dead that grid starts at the death — so real progress no longer waits out
    // the 8-minute gate in silence. A push with nothing new to say is just the
    // clock: it keeps the absolute 8-minute threshold (禁改 34) and on top of it
    // waits out a quiet stretch, because it exists to prove a silent turn is
    // alive, not to tick every minute.
    const dueForContent = hasNewContent && isLongTaskStatusDue(now);
    const dueForStatus =
      !hasNewContent &&
      now - handleStartedAt >= PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS &&
      isLongTaskStatusDue(now) &&
      now - longTaskStatusPaintedAt >= LONG_TASK_QUIET_STATUS_INTERVAL_MS;
    if (!dueForContent && !dueForStatus) {
      if (!previewExpiredNoticeTimer) {
        const dueAt = hasNewContent
          ? nextLongTaskStatusDueAt()
          : Math.max(
              nextLongTaskStatusDueAt(),
              handleStartedAt + PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS,
              longTaskStatusPaintedAt + LONG_TASK_QUIET_STATUS_INTERVAL_MS,
            );
        schedulePreviewExpiredNotice(Math.max(0, dueAt - now), allowUnfrozen);
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
      undeliveredFastText,
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
          advanceProcessLogBookmark(processLogDurable, logTotalAtCompose, logLastTextAtCompose);
        }
        if (undeliveredFastText) {
          pushedFastModeText = undeliveredFastText;
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

  /** A confirmed frame proves the user has this step range on screen. Only a
   *  range that continues the bubble prefix may extend it — a tail view that
   *  skipped ahead leaves a hole the push lane still has to fill. */
  const recordDeliveredProcessLogView = (options?: PreviewDeliveryMetadata): void => {
    const shown = options?.processLogShown;
    if (!shown) {
      // A frame replaces the whole bubble. This one carries no log (a body
      // preview, a thinking snapshot, the frozen status), so the steps that
      // were on screen are gone and only the pushed ones still count.
      processLogBubble.count = processLogDurable.count;
      processLogBubble.lastText = processLogDurable.lastText;
      return;
    }
    if (shown.from > processLogBubble.count) {
      return;
    }
    advanceProcessLogBookmark(processLogBubble, shown.to, shown.lastText);
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

  const sendForcedTransientProgress = async (): Promise<boolean> => {
    if (!forceActivePushRequired()) {
      return false;
    }
    const logText = composeProcessLogLines(processLogDurable.count).join("\n");
    const fastText =
      transientFastModeText && transientFastModeText !== pushedFastModeText
        ? transientFastModeText
        : "";
    const text = [logText, fastText].filter(Boolean).join("\n\n");
    if (!text) {
      return true;
    }
    const logTotalAtCompose = processLogTotalStepCount();
    const logLastTextAtCompose = processLogSteps.at(-1) ?? "";
    try {
      await sendMarkdownChunksViaActivePush(text, {
        reason: "forced-progress",
        isObsolete: () => streamSettled || finalDelivered || supersededByNewInbound,
      });
      if (logText) {
        advanceProcessLogBookmark(processLogDurable, logTotalAtCompose, logLastTextAtCompose);
      }
      if (fastText) {
        pushedFastModeText = fastText;
      }
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
    recordDeliveredProcessLogView(options);
    // ANY confirmed repaint counts against the status slot, not just one that
    // literally carries the status line. The status only ever means "still
    // working", and a fresh progress frame proves that better — without this,
    // a progress frame landing just after the gate was immediately followed by
    // a status frame a second or two later. Stamp the CONFIRMATION time, not
    // `now`: `now` is when the frame was composed, which for a slow ACK can be
    // before the gate and would leave the slot looking unspent.
    markLongTaskStatusPainted();
    recordDeliveredBodySource(options);
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
        retireBubbleForDeadWindow(true);
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
      processLogShown: options?.processLogShown,
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
      retireBubbleForDeadWindow(false);
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
        processLogShown: preview.processLogShown,
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
      if (previewFrozen) {
        startPreviewStatusInterval(LONG_TASK_STATUS_INTERVAL_MS);
      }
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

  /**
   * @param minDelayMs Floor for the next tick. Callers that re-arm AFTER a
   * cycle pass the status interval: a slot that is still due means that cycle
   * put nothing on the bubble (an unacknowledged frame, a lane that handed over
   * to active push), and re-arming on it computes a zero delay and re-enters at
   * once — an unthrottled retry loop that outruns the very cadence this lane
   * exists to serve. Arming fresh (at freeze time) keeps the floor at 0 so a
   * turn that only starts painting after the gate still reports promptly.
   */
  const startPreviewStatusInterval = (minDelayMs = 0): void => {
    if (
      previewStatusInterval ||
      previewStatusInFlight ||
      pendingPreviewFlushInFlight ||
      pendingPreview ||
      streamSettled ||
      streamUpdateUnreliable ||
      supersededByNewInbound ||
      !previewFrozen ||
      previewWatchdogExpired
    ) {
      return;
    }
    // Re-arm only after the current ACK attempt settles. Re-arming immediately
    // at an already-due slot creates an unbounded 0 ms timer loop while the
    // status frame is still in flight, starving the model/tool event loop.
    previewStatusInterval = setTimeout(
      () => {
        previewStatusInterval = undefined;
        void sendFrozenPreviewStatus().finally(() =>
          startPreviewStatusInterval(LONG_TASK_STATUS_INTERVAL_MS),
        );
      },
      Math.max(minDelayMs, nextLongTaskStatusDueAt() - Date.now()),
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
    // Reasoning arrives as cumulative snapshots — tens per second on a long
    // thinking block — and all but one in each throttle window is discarded.
    // Ask the clock BEFORE rendering a frame nobody will send: composing it
    // means normalizing and budgeting the whole block, on the same thread the
    // stream's ACKs are waiting on.
    if (
      !params?.force &&
      lastPreviewText &&
      now - lastPreviewUpdateAt < THINKING_PREVIEW_MIN_UPDATE_MS
    ) {
      return;
    }
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
  const longTaskStatusGateAt = (): number =>
    Math.min(
      handleStartedAt + LONG_TASK_STATUS_AFTER_MS,
      longTaskStatusGateOverrideAt ?? Number.POSITIVE_INFINITY,
    );

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

  /**
   * When the bubble becomes stale enough to look hung. Only armed once the run
   * has reported tool work: that is the shape this exists for (reasoning ends,
   * tools run, nothing repaints). A turn that has shown nothing at all keeps the
   * absolute long-task path untouched (禁改 25).
   */
  const bubbleSilenceDueAt = (): number => {
    if (!toolActivityObserved || !lastPreviewText || previewFrozen) {
      return Number.POSITIVE_INFINITY;
    }
    // Measured from the last time ANY lane put something on the bubble. A
    // heartbeat repaint is not a confirmed preview, so counting only those
    // would leave the deadline in the past and re-fire the timer on a zero
    // delay — the busy loop 禁改 38 already cost us once.
    return Math.max(lastPreviewUpdateAt, longTaskStatusPaintedAt) + PREVIEW_SILENCE_MAX_MS;
  };

  /**
   * The bubble can no longer be repainted, so the push lane takes over now
   * rather than at the 8-minute mark — the gap between the ~6-minute stream
   * window and that mark was pure silence for the user.
   *
   * `bubbleIsPermanent` means WeCom REFUSED the frame (846605/846608): nothing
   * can overwrite that bubble afterwards, not even the final, so the steps it
   * confirmed are already a permanent chat message and the push lane must not
   * repeat them. A merely untrusted ACK ledger proves no such thing.
   */
  const retireBubbleForDeadWindow = (bubbleIsPermanent: boolean): void => {
    streamUpdateUnreliable = true;
    if (!bubbleIsPermanent) {
      // An untrusted ACK ledger is not a closed window: the turn may still be
      // seconds old, and the 8-minute gate is what keeps short turns quiet.
      return;
    }
    // WeCom refusing the frame means the window is spent, which by itself says
    // the turn has been streaming for minutes — but the floor keeps a freak
    // early refusal from turning a young turn into a push conversation.
    longTaskStatusGateOverrideAt ??= Math.max(
      Date.now(),
      handleStartedAt + BLOCK_PREVIEW_MAX_MS,
    );
    advanceProcessLogBookmark(
      processLogDurable,
      processLogBubble.count,
      processLogBubble.lastText,
    );
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
    const delayMs =
      retryDelayMs ??
      Math.max(0, Math.min(nextLongTaskStatusDueAt(), bubbleSilenceDueAt()) - Date.now());
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
    closeDeferred: async () => {
      if (runtimeRetired || streamSettled) {
        return true;
      }
      const deliveredSourceText = previewFrozenDeliveredSourceText || lastDeliveredBodySourceText;
      const unseenBody =
        !deliveredSourceText ||
        !accumulatedText.startsWith(deliveredSourceText) ||
        accumulatedText.slice(deliveredSourceText.length).trim().length > 0;
      if (accumulatedText && unseenBody) {
        // The turn deferred its final, but it produced body text the user has
        // not been shown. Only the final path knows how to chunk, retry and
        // bookmark that remainder, so decline and let the caller run it: losing
        // model output is worse than the notice this close exists to avoid.
        console.info(
          `[wecom-b3] deferred-close-declined account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} bodyChars=${accumulatedText.length} deliveredChars=${deliveredSourceText.length}`,
        );
        return false;
      }
      // Everything this turn produced is already on screen. Finish the stream
      // on that text — an opened WeCom stream that never receives its closing
      // frame keeps rendering as "still generating" for the rest of its window
      // — and invent nothing: this is exactly the case where the normal final
      // degenerated into "最终回复已完成，以上预览内容即为完整回复。" on a turn
      // that had not finished. finalDelivered stays false so a later
      // continuation can still deliver its real answer through this handle.
      console.info(
        `[wecom-b3] deferred-stream-closed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} previewChars=${lastPreviewText.length}`,
      );
      await closeOpenedStreamSilently(lastPreviewText);
      return true;
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
        if (transientProgressKind === "preamble") {
          const steps = payload.channelData?.openclawProgressSteps;
          adoptProcessLogSteps(
            Array.isArray(steps) && steps.length > 0
              ? steps.map((step) => String(step))
              : [progressText],
            Number(payload.channelData?.openclawProgressDroppedSteps ?? 0) || 0,
          );
        } else {
          transientFastModeText = progressText;
        }
        if (await sendForcedTransientProgress()) {
          return;
        }
        const thinkingLimits = resolveThinkingFrameLayout(
          accumulatedThinkingText,
          Boolean(accumulatedText),
        );
        const transientView = composeTransientPreviewSuffix(
          accumulatedText ? PROCESS_LOG_TAIL_WITH_BODY_MAX_CHARS : thinkingLimits.maxChars,
          accumulatedText ? PROCESS_LOG_TAIL_WITH_BODY_MAX_CHARS * 3 : thinkingLimits.maxBytes,
        );
        // Captured at compose time: once this frame is confirmed, these are the
        // steps the bubble holds, and a dead window turns them permanent.
        const shownLogRange = lastProcessLogViewRange;
        const progress = composePreviewSuffixWithinLimits({
          prefix: accumulatedText,
          suffix: transientView,
          separator: "\n",
          maxChars: thinkingLimits.maxChars,
          maxBytes: thinkingLimits.maxBytes,
        });
        const progressPreviewText = thinkingLimits.block
          ? `${thinkingLimits.block}\n${progress.text}`
          : progress.text;
        if (!progressPreviewText || progressPreviewText === lastPreviewText) {
          return;
        }
        // OpenClaw progress is visible process feedback, not answer text.
        // Rendering it through the preview lane keeps it out of accumulatedText
        // and final.
        await sendPreviewUpdate(progressPreviewText, Date.now(), {
          bodySourceText: progress.visiblePrefix,
          showsVisibleBody: Boolean(progress.visiblePrefix),
          // Only claim the range if the whole view survived composition: the
          // wire composer trims an oversized suffix from its tail, and crediting
          // steps that never reached the frame would drop them from the record.
          processLogShown:
            progress.visibleSuffix.trimEnd() === transientView.trimEnd()
              ? shownLogRange
              : undefined,
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

      // OpenClaw deferred this turn's answer to a later run. Everything that
      // would announce completion has to stay off this delivery.
      const deferredTurn = payload.channelData?.wecomDeferredTurn === true;
      let finalText = outboundText;

      // Template cards leave this reply as their own WeCom messages, so the JSON
      // block is stripped before the chunker or the bubble ever sees it — what
      // stays behind is what the user will actually read. A superseded turn
      // stays silent: its cards belong to a conversation the user already
      // moved on from.
      if (
        info.kind === "final" &&
        !isEvent &&
        !supersededByNewInbound &&
        !templateCardsDispatched &&
        containsTemplateCardBlock(finalText)
      ) {
        const extraction = extractTemplateCards(finalText);
        if (extraction.cards.length > 0) {
          const templateCardsSent = await sendTemplateCards({
            client: params.client,
            chatId: peerId,
            chatType: peerKind,
            accountId: params.accountId,
            cards: extraction.cards,
          });
          // Latched before anything can fail: a card is an unrecallable message,
          // and this handle's final can be delivered more than once (a close
          // followed by a handoff notice, a retry). The delivery-key dedupe sits
          // further down and would not stop the second send.
          templateCardsDispatched = true;
          const failedCount = extraction.cards.length - templateCardsSent;
          // A card that never went out must be said out loud: its JSON is gone
          // from the text by now, so silence would leave the turn looking
          // answered when the user received nothing.
          const failureNote = failedCount > 0 ? `⚠️ 有 ${failedCount} 张卡片消息发送失败。` : "";
          const cardOnlyNote = templateCardsSent > 0 ? "📋 卡片消息已发送。" : "";
          finalText =
            [extraction.remainingText, failureNote].filter(Boolean).join("\n\n") || cardOnlyNote;
        }
      }
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
          !deferredTurn &&
          shouldAppendStreamCompletionMarker({
            finalText,
            previewFrozen,
            reasoningOnly: reasoningOnlyFinal,
          });
        if (!isEvent) {
          // A superseded reasoning-only handle must stay silent: promoting
          // the marker here would actively push a stray "（回复完毕）" bubble
          // into the newer conversation.
          if (!finalText && reasoningOnlyFinal && !supersededByNewInbound && !deferredTurn) {
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
              chat_type: peerKind === "group" ? 2 : 1,
            } as Parameters<typeof params.client.sendMessage>[1]),
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
            deferred: deferredTurn,
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
              chat_type: peerKind === "group" ? 2 : 1,
            } as Parameters<typeof params.client.sendMessage>[1]),
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
    markRunActivity: () => {
      if (toolActivityObserved || streamSettled || isEvent || supersededByNewInbound) {
        return;
      }
      // The bubble's next repaint may now be due much sooner than the 8-minute
      // gate the pending timer was armed for, so re-arm from the clock.
      toolActivityObserved = true;
      if (placeholderKeepalive) {
        clearTimeout(placeholderKeepalive);
        placeholderKeepalive = undefined;
      }
      scheduleHeartbeat();
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
