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
  chunkWeComMarkdownV2,
  previewWeComMarkdownV2,
  toWeComMarkdownV2,
} from "../../wecom_msg_adapter/markdown_adapter.js";
import { uploadAndSendBotWsMedia } from "./media.js";

const PLACEHOLDER_KEEPALIVE_MS = 3000;
const MAX_KEEPALIVE_MS = 120 * 1000; // Force stop keepalive after 120s if ignored
const B2_PEER_FINAL_DEDUP_TTL_MS = 120_000;
const WECOM_STREAM_MAX_CHARS = 3_500;
const WECOM_STREAM_FINAL_MAX_CHARS = 2_000;
const WECOM_STREAM_MAX_BYTES = 12_000;
const BLOCK_PREVIEW_MAX_MS = 300_000;
const BLOCK_PREVIEW_MAX_CHARS = 3_000;
const BLOCK_PREVIEW_MIN_UPDATE_MS = 1_500;
const BLOCK_PREVIEW_STATUS_UPDATE_MS = 15_000;
const THINKING_PREVIEW_MIN_UPDATE_MS = 3_000;
const WECOM_REPLY_SEND_TIMEOUT_MS = 8_000;
const WECOM_PENDING_ACK_GRACE_MS = 5_500;
const WECOM_PENDING_ACK_POLL_MS = 100;
const THINKING_BLOCK_MAX_CHARS = 3_000;
const THINKING_BLOCK_MAX_BYTES = 8_000;
const LONG_FINAL_DEDUP_MIN_CHARS = 3_000;
const LONG_FINAL_DEDUP_MIN_SEGMENT_CHARS = 120;
const STRUCTURED_TAIL_MIN_DUPLICATE_LINES = 4;
const FINAL_COMPLETION_MARKER = "（回复完毕）";
const PREVIEW_WATCHDOG_MAX_MS = 60 * 60 * 1000;
// The background-processing notice is only worth a standalone message for
// genuinely long tasks: hold it until the task has been running 9 minutes.
const PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS = 9 * 60_000;
const PREVIEW_EXPIRED_NOTICE_REPEAT_MS = 60_000;
const REPLY_FAIL_NOTICE_TEXT = "⚠️ 本次回复投递中断，请稍后重试或重新发起提问。";
const REPLY_MODEL_TIMEOUT_NOTICE_TEXT = "⚠️ 模型响应超时，本次任务未完成，请稍后重试。";
const REPLY_SESSION_INIT_CONFLICT_NOTICE_TEXT =
  "上一轮任务还在处理中或会话状态刚发生变化，这条消息未能处理，请稍后重新发送。";
const FINAL_PUSH_RETRY_BASE_MS = 20_000;
const FINAL_PUSH_MAX_RETRIES = 3;
const THINK_TAG_RE = /<\/?think>/gi;
const OPEN_THINK_TAG_RE = /<think>/gi;
const CLOSE_THINK_TAG_RE = /<\/think>/gi;
const B3_SUPERSEDED_NOTICE_TEXT = "已收到新消息，合并思考。✅";
const B3_MEDIA_SUPERSEDED_NOTE = "本次回复包含文件，因会话已合并，文件请在新消息中重新发送或确认后重试。";

function appendPreviewSuffixWithinLimits(params: {
  prefix: string;
  suffix: string;
  separator?: string;
  maxChars: number;
  maxBytes: number;
}): string {
  const suffix = previewWeComMarkdownV2(
    params.suffix,
    params.maxChars,
    params.maxBytes,
  ).trim();
  const separator = params.prefix.trim() ? (params.separator ?? "\n\n") : "";
  const availableChars = params.maxChars - separator.length - suffix.length;
  const availableBytes =
    params.maxBytes - Buffer.byteLength(`${separator}${suffix}`, "utf8");
  const prefix =
    availableChars > 0 && availableBytes > 0
      ? previewWeComMarkdownV2(params.prefix, availableChars, availableBytes).trimEnd()
      : "";
  return prefix ? `${prefix}${separator}${suffix}` : suffix;
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
const OBSOLETE_FINAL_RETRY = Symbol("obsolete-final-retry");

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

function formatElapsedStatus(elapsedMs: number): string {
  // A zero-duration measurement is not useful to the user; keep a one-second
  // minimum while retaining the existing whole-second display precision.
  const elapsedSeconds = Math.max(1, Math.floor(Math.max(0, elapsedMs) / 1000));
  if (elapsedSeconds < 60) {
    return `执行长任务中，当前用时${elapsedSeconds}s`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const remainingSeconds = elapsedSeconds % 60;
  return `执行长任务中，当前用时${elapsedMinutes}m${String(remainingSeconds).padStart(2, "0")}s`;
}

function appendFinalCompletionMarker(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed || trimmed.endsWith(FINAL_COMPLETION_MARKER)) {
    return trimmed;
  }
  return `${trimmed}\n\n${FINAL_COMPLETION_MARKER}`;
}

function withOptionalCompletionMarker(chunks: string[], enabled: boolean): string[] {
  if (!enabled || chunks.length === 0) {
    return chunks;
  }
  const out = [...chunks];
  const lastIndex = out.length - 1;
  out[lastIndex] = appendFinalCompletionMarker(out[lastIndex] ?? "");
  return out;
}

function escapeLiteralThinkTags(text: string): string {
  return text.replace(THINK_TAG_RE, (tag) =>
    tag.startsWith("</") ? "&lt;/think&gt;" : "&lt;think&gt;",
  );
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

function renderThinkContent(text: string): string {
  return stripDanglingThinkMarkup(
    trimToUtf8Bytes(
      escapeThinkBlockText(text || "progress").slice(0, THINKING_BLOCK_MAX_CHARS),
      THINKING_BLOCK_MAX_BYTES,
    ).trim(),
  );
}

function renderInlineThinkBlock(text: string): string {
  const escaped = renderThinkContent(text);
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

function composeProgressStreamTextWithThinking(params: {
  thinkingText: string;
  bodyText: string;
}): string {
  const safeBodyText = escapeLiteralThinkTags(params.bodyText);
  const thinkingBlock = renderInlineThinkBlock(params.thinkingText);
  return thinkingBlock ? `${thinkingBlock}\n${safeBodyText}` : safeBodyText;
}

// Global registry to track active keepalives by peerId
interface ActiveKeepalive {
  reqId: string;
  stop: () => void;
}
const activeKeepalivesByPeer = new Map<string, Set<ActiveKeepalive>>();

export function __resetBotWsReplyTestState(): void {
  recentFinalDeliveriesByPeer.clear();
  pendingFinalRetryByPeer.clear();
  activeKeepalivesByPeer.clear();
}

export function createBotWsReplyHandle(params: {
  client: WSClient;
  frame: WsFrame<BaseMessage | EventMessage>;
  accountId: string;
  inboundKind: string;
  placeholderContent?: string;
  autoSendPlaceholder?: boolean;
  deferActivation?: boolean;
  onDeliver?: () => void;
  onFail?: (error: unknown) => void;
}): ReplyHandle {
  let streamId: string | undefined;
  let accumulatedText = "";
  let accumulatedThinkingText = "";
  let deferredMediaUrls: string[] = [];
  const resolveStreamId = () => {
    streamId ||= generateReqId("stream");
    return streamId;
  };

  const placeholderText = params.placeholderContent?.trim() || "⏳ 正在思考中...\n\n";
  let streamSettled = false;
  let placeholderInFlight = false;
  let placeholderKeepalive: ReturnType<typeof setInterval> | undefined;
  let placeholderTimeout: ReturnType<typeof setTimeout> | undefined;
  let previewFreezeTimeout: ReturnType<typeof setTimeout> | undefined;
  let previewStatusInterval: ReturnType<typeof setInterval> | undefined;
  let previewStatusInFlight = false;
  let previewInFlightCount = 0;
  type PendingPreview = {
    text: string;
    bodySourceText?: string;
    progressOnly?: boolean;
    deadline: number;
    retryCount: number;
  };
  let pendingPreview: PendingPreview | undefined;
  let pendingPreviewPollTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingPreviewFlushInFlight = false;

  // Extract peerId for clustering handles
  const body = params.frame.body as any;
  const peerId = String(
    (body?.chattype === "group" ? body?.chatid || body?.from?.userid : body?.from?.userid) ||
      "unknown",
  );
  const peerKeyId = normalizePeerKey(peerId);
  const peerKind: "direct" | "group" = body?.chattype === "group" ? "group" : "direct";
  const reqId = params.frame.headers.req_id || "unknown";
  const replyPeerKey = JSON.stringify([params.accountId, peerKind, peerKeyId]);
  const activationId = crypto.randomUUID();
  let activated = false;

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

  const stopPlaceholderKeepalive = () => {
    if (placeholderKeepalive) {
      clearInterval(placeholderKeepalive);
      placeholderKeepalive = undefined;
    }
    if (placeholderTimeout) {
      clearTimeout(placeholderTimeout);
      placeholderTimeout = undefined;
    }

    // Remove from registry
    const keepalives = activeKeepalivesByPeer.get(peerKeyId);
    if (keepalives) {
      for (const ka of keepalives) {
        if (ka.reqId === reqId) {
          keepalives.delete(ka);
        }
      }
      if (keepalives.size === 0) {
        activeKeepalivesByPeer.delete(peerKeyId);
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

  const sendPlaceholder = () => {
    if (!activated || streamSettled || placeholderInFlight || isEvent) return;
    placeholderInFlight = true;
    withHandleSendTimeout(
      params.client.replyStream(params.frame, resolveStreamId(), placeholderText, false),
      "stream placeholder",
      )
      .catch((error) => {
        if (isLocalReplyTimeoutError(error)) {
          console.warn(
            `[wecom-preview] placeholder-timeout account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
          );
          return;
        }
        if (!isTerminalReplyError(error)) {
          console.warn(
            `[wecom-preview] placeholder-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
          );
          return;
        }
        // SDK 1.0.6 matches ACKs only by req_id. After an ACK timeout, a late
        // placeholder ACK could resolve a newer frame if this callback req_id
        // were reused, so all subsequent delivery must leave the old stream.
        streamUpdateUnreliable = true;
        settleStream();
        params.onFail?.(error);
      })
      .finally(() => {
        placeholderInFlight = false;
      });
  };

  const notifyPeerActive = () => {
    if (!activated || supersededByNewInbound) {
      return;
    }
    // A genuine reply or reasoning is happening on THIS handle.
    // It means the core SDK has chosen this handle to deliver the response.
    // We can safely terminate all other orphaned keepalives for this peer to prevent infinite loops.
    const keepalives = activeKeepalivesByPeer.get(peerKeyId);
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
  let supersededAt: number | undefined;
  let visibleReplyStarted = false;
  let streamUpdateUnreliable = false;
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
  let lastPreviewStatusAt = 0;
  let previewExpiredNoticeInFlight = false;
  let previewExpiredNoticeCancelled = false;
  let previewExpiredNoticeTimer: ReturnType<typeof setTimeout> | undefined;
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
        | "fail-notice";
      appendCompletionMarker?: boolean;
      progress?: { delivered: number };
      maxChars?: number;
      maxBytes?: number;
      isObsolete?: () => boolean;
    },
  ): Promise<void> => {
    const throwIfObsolete = (): void => {
      if (options.isObsolete?.()) {
        throw OBSOLETE_FINAL_RETRY;
      }
    };
    throwIfObsolete();
    const markdownChunks = withOptionalCompletionMarker(
      chunkWeComMarkdownV2(
        textToSend,
        options.maxChars ?? WECOM_STREAM_MAX_CHARS,
        options.maxBytes ?? WECOM_STREAM_MAX_BYTES,
      ).map(escapeLiteralThinkTags),
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
    if (!pushHandle?.isConnected?.()) {
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
      // Only a final the user has actually seen part of may be dropped for a
      // new activation; an entirely undelivered final keeps its retry, else
      // the next message would destroy the answer instead of releasing it.
      shouldCancelForNewActivation: () =>
        visibleReplyStarted && (finalPushProgress?.delivered ?? 0) > 0,
    });
    return true;
  };

  // Bounded retry chain for finals whose fallback push failed. Without it a
  // failed active push after stream expiry silently drops the answer
  // (rollbackFinalDelivered + return). Timers live in this closure, so each
  // req_id/session retries independently; run-time guards keep B3 supersede
  // semantics (a suppressed superseded final is never re-pushed).
  const runFinalPushRetry = async (retry: FinalPushRetryRequest): Promise<void> => {
    if (!isCurrentReplyActivation()) {
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
  };

  const resolveStreamFallbackText = (finalText: string): string => {
    const deliveredSourceText = previewFrozenDeliveredSourceText || lastDeliveredBodySourceText;
    if (!deliveredSourceText || !finalText.startsWith(deliveredSourceText)) {
      return finalText;
    }
    const remainder = finalText.slice(deliveredSourceText.length).trimStart();
    if (!remainder) {
      return "最终回复已完成，以上预览内容即为完整回复。";
    }
    if (remainder === FINAL_COMPLETION_MARKER) {
      return FINAL_COMPLETION_MARKER;
    }
    return `继续输出：\n\n${remainder}`;
  };

  const deliverNormalFinalViaStream = async (
    finalText: string,
    options: {
      appendCompletionMarker: boolean;
      deliveryKey: string;
      peerDedup: boolean;
    },
  ): Promise<boolean | "retry-scheduled"> => {
    const markdownChunks = withOptionalCompletionMarker(
      chunkWeComMarkdownV2(
        finalText,
        WECOM_STREAM_FINAL_MAX_CHARS,
        WECOM_STREAM_MAX_BYTES,
      ).map(escapeLiteralThinkTags),
      options.appendCompletionMarker,
    );
    const finalStreamId = resolveStreamId();
    const firstStreamChunk = markdownChunks[0] ?? "";
    const pendingAckCleared = await waitForPendingReplyAckToClear({
      client: params.client,
      frame: params.frame,
      hasLocalPendingReply: () => placeholderInFlight || previewInFlightCount > 0,
    });
    const fallbackText = resolveStreamFallbackText(finalText);
    // The fallback retry must reuse the EXACT identity of the failed push
    // (text/marker/default limits): any drift would reset the tracked chunk
    // progress and re-push chunks the user already confirmed-received.
    const fallbackRetryRequest = (): FinalPushRetryRequest => ({
      text: fallbackText,
      deliveryKey: options.deliveryKey,
      peerDedup: options.peerDedup,
      appendCompletionMarker: true,
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
          appendCompletionMarker: true,
          progress: resolveFinalPushProgress(fallbackText, true),
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
          appendCompletionMarker: true,
          progress: resolveFinalPushProgress(fallbackText, true),
        });
        visibleReplyStarted = true;
      } catch (fallbackError) {
        return settleActivePushFailure(fallbackError);
      }
      return true;
    }
    if (streamUpdateUnreliable) {
      console.warn(
        `[wecom-b3] stream-final-skip-unreliable account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId}`,
      );
      try {
        await sendMarkdownChunksViaActivePush(fallbackText, {
          reason: "stream-fallback",
          appendCompletionMarker: true,
          progress: resolveFinalPushProgress(fallbackText, true),
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
        params.client.replyStream(params.frame, finalStreamId, firstStreamChunk, true),
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
            appendCompletionMarker: true,
            progress: resolveFinalPushProgress(fallbackText, true),
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
          appendCompletionMarker: true,
          progress: resolveFinalPushProgress(fallbackText, true),
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
    if (!finalStreamId || isEvent || supersededByNewInbound || streamUpdateUnreliable) {
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
    if (!pendingAckCleared || supersededByNewInbound) {
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

  const renderPreviewText = (text: string, now = Date.now()): string => {
    if (!text) {
      return "";
    }
    const thinkingLimits = resolveThinkingAwareBodyLimits(accumulatedThinkingText);
    const elapsedMs = now - handleStartedAt;
    if (!previewFrozen && (elapsedMs >= BLOCK_PREVIEW_MAX_MS || text.length >= BLOCK_PREVIEW_MAX_CHARS)) {
      previewFrozen = true;
      previewFrozenSourceText = text.slice(0, BLOCK_PREVIEW_MAX_CHARS);
      previewFrozenText = previewWeComMarkdownV2(
        previewFrozenSourceText,
        thinkingLimits.maxChars,
        thinkingLimits.maxBytes,
      );
      // Self-healing: start the status refresh interval at freeze time
      // instead of waiting for the first frozen preview send to succeed —
      // a skipped/failed first send would otherwise leave the counter dead.
      startPreviewStatusInterval();
    }
    if (previewFrozen) {
      const frozen =
        previewFrozenText ||
        previewWeComMarkdownV2(
          text.slice(0, BLOCK_PREVIEW_MAX_CHARS),
          thinkingLimits.maxChars,
          thinkingLimits.maxBytes,
        );
      return appendPreviewSuffixWithinLimits({
        prefix: frozen,
        suffix: formatElapsedStatus(elapsedMs),
        maxChars: thinkingLimits.maxChars,
        maxBytes: thinkingLimits.maxBytes,
      });
    }
    return previewWeComMarkdownV2(text, thinkingLimits.maxChars, thinkingLimits.maxBytes);
  };

  const resolveVisibleBodySourceText = (sourceText: string, now = Date.now()): string => {
    if (!sourceText) {
      return "";
    }
    const thinkingLimits = resolveThinkingAwareBodyLimits(accumulatedThinkingText);
    const statusText = previewFrozen ? formatElapsedStatus(now - handleStartedAt) : "";
    const bodyLimits = statusText
      ? {
          maxChars: Math.max(100, thinkingLimits.maxChars - statusText.length - 2),
          maxBytes: Math.max(
            512,
            thinkingLimits.maxBytes - Buffer.byteLength(`\n\n${statusText}`, "utf8"),
          ),
        }
      : thinkingLimits;
    const sourceLimit = previewFrozen
      ? (previewFrozenSourceText || sourceText.slice(0, BLOCK_PREVIEW_MAX_CHARS))
      : sourceText;
    const visibleBodyText = previewWeComMarkdownV2(
      sourceLimit,
      bodyLimits.maxChars,
      bodyLimits.maxBytes,
    );
    if (!visibleBodyText) {
      return "";
    }
    if (sourceLimit.startsWith(visibleBodyText)) {
      return visibleBodyText;
    }
    const visibleChunks = chunkWeComMarkdownV2(
      sourceLimit,
      bodyLimits.maxChars,
      bodyLimits.maxBytes,
    );
    return visibleChunks.length <= 1 && visibleChunks[0] === visibleBodyText ? sourceLimit : "";
  };

  const stopPreviewExpiredNoticeTimer = (): void => {
    if (previewExpiredNoticeTimer) {
      clearTimeout(previewExpiredNoticeTimer);
      previewExpiredNoticeTimer = undefined;
    }
  };

  const cancelPreviewExpiredNotice = (): void => {
    previewExpiredNoticeCancelled = true;
    stopPreviewExpiredNoticeTimer();
  };

  // Recurring active push after the frozen preview channel dies (typically
  // errcode 846608 once the WeCom stream window closes at ~6 min). Without
  // it the bubble goes silent forever while the task is still running. The
  // first push is held until the task has been processing for at least
  // PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS, then repeats once per minute until
  // final settlement or supersede. Recursive timeouts avoid overlapping
  // sends when a push itself is slow.
  const schedulePreviewExpiredNotice = (delayMs: number, allowUnfrozen: boolean): void => {
    if (
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
    previewExpiredNoticeTimer = setTimeout(() => {
      previewExpiredNoticeTimer = undefined;
      maybeSendPreviewExpiredNotice(allowUnfrozen);
    }, delayMs);
    previewExpiredNoticeTimer.unref?.();
  };

  const maybeSendPreviewExpiredNotice = (allowUnfrozen = false): void => {
    if (
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
    stopPreviewExpiredNoticeTimer();
    previewExpiredNoticeInFlight = true;
    const elapsedMs = Date.now() - handleStartedAt;
    void sendMarkdownChunksViaActivePush(formatElapsedStatus(elapsedMs), {
      reason: "preview-expired",
    })
      .then(() => {
        console.info(
          `[wecom-preview] expired-notice account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} elapsedMs=${elapsedMs}`,
        );
      })
      .catch((error) => {
        console.warn(
          `[wecom-preview] expired-notice-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
        );
      })
      .finally(() => {
        previewExpiredNoticeInFlight = false;
        schedulePreviewExpiredNotice(PREVIEW_EXPIRED_NOTICE_REPEAT_MS, allowUnfrozen);
      });
  };

  const recordDeliveredBodySource = (
    options?: { bodySourceText?: string; progressOnly?: boolean },
  ): void => {
    if (options?.progressOnly) {
      return;
    }
    lastDeliveredBodySourceText = options?.bodySourceText ?? "";
    if (previewFrozen) {
      previewFrozenDeliveredSourceText = options?.bodySourceText ?? "";
    }
  };

  // Reasoning-only previews render as a collapsed <think> block: the user has
  // not seen any visible reply body yet. Treating them as "visible reply
  // started" made supersede silently discard the run's real final answer.
  // Body-carrying callers always pass a bodySourceText STRING — possibly ""
  // when the markdown adapter transformed the body beyond source mapping — so
  // presence (not truthiness) is the visibility signal; only the pure
  // reasoning snapshot passes undefined.
  const previewShowsVisibleBody = (
    options?: { bodySourceText?: string; progressOnly?: boolean },
  ): boolean => Boolean(options && (options.bodySourceText !== undefined || options.progressOnly));

  const recordDeliveredPreview = (
    previewText: string,
    now: number,
    options?: { bodySourceText?: string; progressOnly?: boolean },
  ): void => {
    if (streamSettled || supersededByNewInbound) {
      return;
    }
    stopPlaceholderKeepalive();
    if (previewShowsVisibleBody(options)) {
      visibleReplyStarted = true;
    }
    lastPreviewText = previewText;
    lastPreviewUpdateAt = now;
    recordDeliveredBodySource(options);
    if (previewFrozen) {
      stopPreviewFreezeTimeout();
      lastPreviewStatusAt = now;
      startPreviewStatusInterval();
    }
  };

  const sendPreviewUpdate = async (
    previewText: string,
    now: number,
    options?: { bodySourceText?: string; fromPendingSlot?: boolean; progressOnly?: boolean },
  ): Promise<boolean> => {
    if (streamSettled || isEvent || supersededByNewInbound || streamUpdateUnreliable) {
      return false;
    }
    const previewStreamId = resolveStreamId();
    const directAttempt = options?.fromPendingSlot !== true;
    if (
      directAttempt &&
      (placeholderInFlight ||
        previewInFlightCount > 0 ||
        pendingPreviewFlushInFlight ||
        hasPendingReplyAck(params.client, params.frame))
    ) {
      stopPlaceholderKeepalive();
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
      if (isTerminalReplyError(error)) {
        if (isLocalReplyTimeoutError(error)) {
          void previewSendPromise.then(
            (result) => {
              if (
                result === "skipped" ||
                supersededByNewInbound
              ) {
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
        console.warn(
          `[wecom-preview] terminal-update-stopped account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${previewStreamId} error=${formatFallbackError(error)}`,
        );
        streamUpdateUnreliable = true;
        clearPendingPreview();
        stopPreviewFreezeTimeout();
        stopPreviewStatusInterval();
        // allowUnfrozen: reasoning-only bubbles (and pre-freeze deaths) never
        // freeze the preview, yet their tasks equally deserve the deferred
        // background notice — the 9-minute gate itself filters short tasks.
        maybeSendPreviewExpiredNotice(true);
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
    options?: { bodySourceText?: string; progressOnly?: boolean },
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
      progressOnly: options?.progressOnly,
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
        progressOnly: preview.progressOnly,
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

  const renderPreviewStreamText = (bodyText: string): string => {
    if (!accumulatedThinkingText) {
      return escapeLiteralThinkTags(bodyText);
    }
    return composeProgressStreamTextWithThinking({
      thinkingText: accumulatedThinkingText,
      bodyText,
    });
  };

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
    if (checkPreviewWatchdogExpired(Date.now())) {
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
    if (now - lastPreviewStatusAt < BLOCK_PREVIEW_STATUS_UPDATE_MS) {
      return;
    }
    const previewText = renderPreviewStreamText(renderPreviewText(accumulatedText || previewFrozenText, now));
    if (!previewText || previewText === lastPreviewText) {
      return;
    }
    previewStatusInFlight = true;
    try {
      await sendPreviewUpdate(previewText, now, {
        bodySourceText: resolveVisibleBodySourceText(
          accumulatedText || previewFrozenSourceText,
          now,
        ),
      });
    } finally {
      previewStatusInFlight = false;
    }
  };

  const startPreviewStatusInterval = (): void => {
    if (previewStatusInterval || streamSettled || !previewFrozen || previewWatchdogExpired) {
      return;
    }
    previewStatusInterval = setInterval(() => {
      void sendFrozenPreviewStatus();
    }, BLOCK_PREVIEW_STATUS_UPDATE_MS);
  };

  const freezePreviewByTimeout = async (): Promise<void> => {
    if (streamSettled || previewFrozen || !accumulatedText || isEvent || supersededByNewInbound) {
      return;
    }
    const now = Date.now();
    const previewText = renderPreviewStreamText(renderPreviewText(accumulatedText, now));
    if (!previewFrozen || !previewText || previewText === lastPreviewText) {
      return;
    }
    await sendPreviewUpdate(previewText, now, {
      bodySourceText: resolveVisibleBodySourceText(accumulatedText, now),
    });
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
      return now - lastPreviewStatusAt >= BLOCK_PREVIEW_STATUS_UPDATE_MS;
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
    const bodyPreviewText = accumulatedText ? renderPreviewText(accumulatedText, now) : "";
    const previewText = renderPreviewStreamText(bodyPreviewText);
    if (!params?.force && !shouldSendThinkingPreview(previewText, now)) {
      return;
    }
    await sendPreviewUpdate(previewText, now, {
      bodySourceText: accumulatedText
        ? resolveVisibleBodySourceText(accumulatedText, now)
        : undefined,
    });
  };

  const deliverBlockPreview = async (text: string): Promise<void> => {
    if (streamSettled || streamUpdateUnreliable || isEvent || supersededByNewInbound || !text) {
      return;
    }
    const now = Date.now();
    if (!shouldSendPreview(text, now)) {
      return;
    }
    const previewText = renderPreviewStreamText(renderPreviewText(text, now));
    if (!previewText || previewText === lastPreviewText) {
      return;
    }
    const delivered = await sendPreviewUpdate(previewText, now, {
      bodySourceText: resolveVisibleBodySourceText(text, now),
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
      streamUpdateUnreliable ||
      placeholderInFlight ||
      previewInFlightCount > 0 ||
      hasPendingReplyAck(params.client, params.frame)
    ) {
      return;
    }
    supersededNoticeSent = true;
    const noticeStreamId = resolveStreamId();
    void withHandleSendTimeout(
      params.client.replyStream(params.frame, noticeStreamId, B3_SUPERSEDED_NOTICE_TEXT, true),
      "supersede notice",
    )
      .then(() => {
        console.info(
          `[wecom-b3] supersede-notice account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${noticeStreamId}`,
        );
      })
      .catch((error) => {
        if (isTerminalReplyError(error)) {
          streamUpdateUnreliable = true;
        }
        console.warn(
          `[wecom-b3] supersede-notice-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${noticeStreamId} error=${formatFallbackError(error)}`,
        );
      });
  };

  const activate = (): void => {
    if (activated) {
      return;
    }
    activated = true;
    cancelPendingFinalRetryForNewActivation(replyPeerKey, activationId);
    if (params.autoSendPlaceholder === false || isEvent) {
      return;
    }
    sendPlaceholder();
    placeholderKeepalive = setInterval(() => {
      sendPlaceholder();
    }, PLACEHOLDER_KEEPALIVE_MS);

    // Safety net: force stop keepalive after MAX_KEEPALIVE_MS
    // in case the message is completely ignored by the core and never triggers deliver/fail
    placeholderTimeout = setTimeout(() => {
      stopPlaceholderKeepalive();
    }, MAX_KEEPALIVE_MS);

    // Register keepalive
    let keepalives = activeKeepalivesByPeer.get(peerKeyId);
    if (!keepalives) {
      keepalives = new Set();
      activeKeepalivesByPeer.set(peerKeyId, keepalives);
    }
    keepalives.add({ reqId, stop: stopPlaceholderKeepalive });
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
    activate,
    deliver: async (payload: ReplyPayload, info) => {
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
        // the source stream and never fall back by re-pushing its partial text.
        finalDelivered = true;
        await closeOpenedStreamSilently(lastPreviewText);
        return;
      }

      if (payload.channelData?.openclawProgressKind === "fast-mode-auto") {
        const fastText = payload.text?.trim() ?? "";
        if (!fastText || isEvent || supersededByNewInbound || streamSettled) {
          return;
        }
        const thinkingLimits = resolveThinkingAwareBodyLimits(accumulatedThinkingText);
        const progressBodyText = appendPreviewSuffixWithinLimits({
          prefix: escapeLiteralThinkTags(accumulatedText),
          suffix: fastText,
          separator: "\n",
          maxChars: thinkingLimits.maxChars,
          maxBytes: thinkingLimits.maxBytes,
        });
        const progressPreviewText = renderPreviewStreamText(progressBodyText);
        if (!progressPreviewText || progressPreviewText === lastPreviewText) {
          return;
        }
        await sendPreviewUpdate(progressPreviewText, Date.now(), { progressOnly: true });
        return;
      }

      if (payload.isReasoning) {
        // We reset the safety timeout if reasoning is actively streaming
        if (placeholderTimeout && !isEvent) {
          clearTimeout(placeholderTimeout);
          placeholderTimeout = setTimeout(() => {
            stopPlaceholderKeepalive();
          }, MAX_KEEPALIVE_MS);
        }
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
      const currentFinalUsesPeerDedup = info.kind === "final" && !supersededByNewInbound;
      if (info.kind === "final" && mediaUrls.length > 0) {
        const cfg = getWecomRuntime().config.loadConfig();
        const mediaLocalRoots = resolveWecomMergedMediaLocalRoots({ cfg });
        const mediaMaxBytes = resolveWecomMediaMaxBytes(cfg, params.accountId);
        currentFinalDeliveryKey = buildFinalDeliveryKey({
          accountId: params.accountId,
          peerKind,
          peerId: peerKeyId,
          reqId,
          text: outboundText,
          mediaUrls,
        });
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
      if (info.kind === "final") {
        const reasoningOnlyFinal = !finalText && !!accumulatedThinkingText;
        finalText = dedupeLongFinalText(finalText, { previewFrozen });
        finalAppendCompletionMarker =
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
          await closeOpenedStreamSilently();
        }
        return;
      }

      if (info.kind === "final" && !currentFinalDeliveryKey) {
        currentFinalDeliveryKey = buildFinalDeliveryKey({
          accountId: params.accountId,
          peerKind,
          peerId: peerKeyId,
          reqId,
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
        if (params.inboundKind === "welcome") {
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
          const fallbackText = resolveStreamFallbackText(finalText);
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
                text: resolveStreamFallbackText(finalText),
                deliveryKey: currentFinalDeliveryKey,
                peerDedup: currentFinalUsesPeerDedup,
                appendCompletionMarker: true,
                alreadyMarkedDelivered: finalMediaDelivered,
                preserveDeliveryClaim: finalMediaDelivered,
              });
            }
            return;
          }
        } else {
          stopPlaceholderKeepalive();
          visibleReplyStarted = true;
          await withHandleSendTimeout(
            sendNonFinalStreamUpdate({
              client: params.client,
              frame: params.frame,
              streamId: resolveStreamId(),
              content: renderPreviewStreamText(previewWeComMarkdownV2(finalText)),
            }),
            "direct block stream",
          );
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
      const initConflict = isRetryableReplySessionAdmissionError(error);
      // Only append the notice to previews that carried visible body text,
      // and rebuild the progress from the body-only source: lastPreviewText
      // can embed the <think> block, whose wrapper the markdown sanitizer
      // strips — promoting raw reasoning summaries to visible text.
      const failNoticeText = initConflict
        ? REPLY_SESSION_INIT_CONFLICT_NOTICE_TEXT
        : modelTimeout
          ? REPLY_MODEL_TIMEOUT_NOTICE_TEXT
          : noVisibleOutput && lastPreviewText && accumulatedText
            ? appendFailureNoticeToProgress(accumulatedText, REPLY_FAIL_NOTICE_TEXT)
            : REPLY_FAIL_NOTICE_TEXT;
      const text = initConflict || modelTimeout || noVisibleOutput
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
      if (!isEvent && params.inboundKind !== "welcome" && streamUpdateUnreliable) {
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
        if (supersededByNewInbound) {
          params.onFail?.(error);
          return;
        }
        if (!pendingAckCleared || streamUpdateUnreliable) {
          await sendFailNoticeOnce();
          params.onFail?.(error);
          return;
        }
      }
      try {
        if (params.inboundKind === "welcome") {
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
      stopPlaceholderKeepalive();
      stopPreviewFreezeTimeout();
      stopPreviewStatusInterval();
      cancelPreviewExpiredNotice();
      clearPendingPreview();
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
