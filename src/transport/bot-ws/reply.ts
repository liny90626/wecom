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
const LONG_FINAL_DEDUP_MIN_BLOCK_CHARS = 500;
const LONG_FINAL_DEDUP_MIN_SEGMENT_CHARS = 120;
const LONG_FINAL_DEDUP_MAX_REMOVALS = 3;
const FINAL_COMPLETION_MARKER = "（回复完毕）";
const PREVIEW_WATCHDOG_MAX_MS = 60 * 60 * 1000;
const PREVIEW_EXPIRED_NOTICE_TEXT =
  "⏳ 进度预览暂时无法继续刷新，任务仍在后台处理，完成后将以新消息发送。";
const REPLY_FAIL_NOTICE_TEXT = "⚠️ 本次回复投递中断，请稍后重试或重新发起提问。";
const FINAL_PUSH_RETRY_BASE_MS = 20_000;
const FINAL_PUSH_MAX_RETRIES = 3;
const THINK_TAG_RE = /<\/?think>/gi;
const OPEN_THINK_TAG_RE = /<think>/gi;
const CLOSE_THINK_TAG_RE = /<\/think>/gi;
const B3_SUPERSEDED_NOTICE_TEXT = "已收到新消息，合并思考。✅";
const B3_MEDIA_SUPERSEDED_NOTE = "本次回复包含文件，因会话已合并，文件请在新消息中重新发送或确认后重试。";

const recentFinalDeliveriesByPeer = new Map<string, number>();

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
 * the WeCom server does not acknowledge a reply within 5 s.  Once timed out
 * the reqId slot is released; further replies on the same reqId will fail. */
function isAckTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ack timeout");
}

function isLocalReplyTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "WeComReplyTimeoutError";
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
}): Promise<boolean> {
  if (!hasPendingReplyAck(params.client, params.frame)) {
    return true;
  }
  const deadline = Date.now() + (params.timeoutMs ?? WECOM_PENDING_ACK_GRACE_MS);
  while (hasPendingReplyAck(params.client, params.frame)) {
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
  text: string;
  mediaUrls: readonly string[];
}): string {
  const { accountId, peerKind, peerId, text, mediaUrls } = params;
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

function isDedupProtectedBlock(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed) return true;
  if (/^\|.*\|$/m.test(trimmed)) return true;
  if (/^```/.test(trimmed) || /```$/.test(trimmed)) return true;
  return false;
}

function splitDedupBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    blocks.push(current.join("\n"));
    current = [];
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      blocks.push(line);
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function dedupeLongFinalText(text: string, options: { previewFrozen: boolean }): string {
  if (!options.previewFrozen && text.length < LONG_FINAL_DEDUP_MIN_CHARS) {
    return text;
  }

  const blocks = splitDedupBlocks(text);
  const seen = new Map<string, number>();
  let removed = 0;
  let changed = false;
  const out: string[] = [];

  for (const block of blocks) {
    const normalized = normalizeDedupText(block);
    const duplicate =
      removed < LONG_FINAL_DEDUP_MAX_REMOVALS &&
      block.length >= LONG_FINAL_DEDUP_MIN_SEGMENT_CHARS &&
      normalized.length >= LONG_FINAL_DEDUP_MIN_SEGMENT_CHARS &&
      !isDedupProtectedBlock(block) &&
      seen.has(normalized);

    if (duplicate) {
      removed += 1;
      changed = true;
      continue;
    }

    out.push(block);
    if (
      block.length >= LONG_FINAL_DEDUP_MIN_SEGMENT_CHARS &&
      normalized.length >= LONG_FINAL_DEDUP_MIN_SEGMENT_CHARS &&
      !isDedupProtectedBlock(block)
    ) {
      seen.set(normalized, out.length - 1);
    }
  }

  let deduped = changed ? out.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text;
  for (let pass = removed; pass < LONG_FINAL_DEDUP_MAX_REMOVALS; pass += 1) {
    const match = findRepeatedLongBlock(deduped);
    if (!match) break;
    deduped = `${deduped.slice(0, match.start)}${deduped.slice(match.end)}`.replace(/\n{3,}/g, "\n\n").trim();
    changed = true;
  }
  const repeatedTail = findRepeatedHeadingTail(deduped);
  if (repeatedTail) {
    deduped = deduped.slice(0, repeatedTail.start).replace(/\n{3,}/g, "\n\n").trim();
    changed = true;
  }

  return changed ? deduped : text;
}

function findRepeatedLongBlock(text: string): { start: number; end: number } | undefined {
  const paragraphs = splitDedupBlocks(text);
  const seen = new Map<string, string>();
  let searchFrom = 0;

  for (const paragraph of paragraphs) {
    const start = text.indexOf(paragraph, searchFrom);
    if (start < 0) {
      continue;
    }
    const end = start + paragraph.length;
    searchFrom = end;

    if (paragraph.length < LONG_FINAL_DEDUP_MIN_BLOCK_CHARS || isDedupProtectedBlock(paragraph)) {
      continue;
    }
    const normalized = normalizeDedupText(paragraph);
    if (normalized.length < LONG_FINAL_DEDUP_MIN_BLOCK_CHARS) {
      continue;
    }
    if (seen.has(normalized)) {
      return { start, end };
    }
    seen.set(normalized, paragraph);
  }

  return undefined;
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
    return { start: second.start, end: text.length };
  }

  return undefined;
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
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (elapsedSeconds < 30) {
    return `正在思考中...${elapsedSeconds}s`;
  }
  if (elapsedSeconds < 60) {
    return `正在处理数据...${elapsedSeconds}s`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const remainingSeconds = elapsedSeconds % 60;
  return `正在整理结果...${elapsedMinutes}m${String(remainingSeconds).padStart(2, "0")}s`;
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
  return trimToUtf8Bytes(
    escapeThinkBlockText(text || "progress").slice(0, THINKING_BLOCK_MAX_CHARS),
    THINKING_BLOCK_MAX_BYTES,
  ).trim();
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
    maxChars: WECOM_STREAM_MAX_CHARS,
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
  activeKeepalivesByPeer.clear();
}

export function createBotWsReplyHandle(params: {
  client: WSClient;
  frame: WsFrame<BaseMessage | EventMessage>;
  accountId: string;
  inboundKind: string;
  placeholderContent?: string;
  autoSendPlaceholder?: boolean;
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

  // Extract peerId for clustering handles
  const body = params.frame.body as any;
  const peerId = String(
    (body?.chattype === "group" ? body?.chatid || body?.from?.userid : body?.from?.userid) ||
      "unknown",
  );
  const peerKeyId = normalizePeerKey(peerId);
  const peerKind: "direct" | "group" = body?.chattype === "group" ? "group" : "direct";
  const reqId = params.frame.headers.req_id || "unknown";

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

  const settleStream = () => {
    if (streamSettled) return;
    streamSettled = true;
    stopPlaceholderKeepalive();
    stopPreviewFreezeTimeout();
    stopPreviewStatusInterval();
  };

  const sendPlaceholder = () => {
    if (streamSettled || placeholderInFlight || isEvent) return;
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
        settleStream();
        params.onFail?.(error);
      })
      .finally(() => {
        placeholderInFlight = false;
      });
  };

  const notifyPeerActive = () => {
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
  let previewStartedAt: number | undefined;
  let previewFrozen = false;
  let previewFrozenSourceText = "";
  let previewFrozenDeliveredSourceText = "";
  let previewFrozenText = "";
  let lastPreviewText = "";
  let lastDeliveredBodySourceText = "";
  let lastPreviewUpdateAt = 0;
  let lastPreviewStatusAt = 0;
  let previewExpiredNoticeSent = false;
  let previewWatchdogExpired = false;
  let failNoticeSent = false;
  let finalPushRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let finalPushRetryCount = 0;
  let finalPushProgress: { forText: string; withMarker: boolean; delivered: number } | undefined;

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

  // Chunk-delivery progress for the final's fallback/retry pushes. Chunking
  // is deterministic for the same (text, marker) pair, so a retry can skip
  // chunks that already reached the user instead of re-sending the whole
  // answer from chunk 0 (which would duplicate delivered segments).
  const resolveFinalPushProgress = (
    text: string,
    withMarker: boolean,
  ): { delivered: number } => {
    if (
      !finalPushProgress ||
      finalPushProgress.forText !== text ||
      finalPushProgress.withMarker !== withMarker
    ) {
      finalPushProgress = { forText: text, withMarker, delivered: 0 };
    }
    return finalPushProgress;
  };

  const sendMarkdownChunksViaActivePush = async (
    textToSend: string,
    options: {
      reason:
        | "superseded-final"
        | "stream-fallback"
        | "final-retry"
        | "preview-expired"
        | "fail-notice";
      appendCompletionMarker?: boolean;
      progress?: { delivered: number };
    },
  ): Promise<void> => {
    const markdownChunks = withOptionalCompletionMarker(
      chunkWeComMarkdownV2(textToSend).map(escapeLiteralThinkTags),
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
    };
    const sendViaClient = async (startIndex = firstIndex): Promise<void> => {
      for (let i = startIndex; i < markdownChunks.length; i += 1) {
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
        const chunk = markdownChunks[i] ?? "";
        console.info(
          `[wecom-b3] active-push account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} reason=${options.reason} chunk=${i + 1}/${markdownChunks.length}`,
        );
        await withHandleSendTimeout(pushHandle.sendMarkdown(peerId, chunk), "active markdown push");
        markChunkDelivered(i);
        if (i < markdownChunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      } catch (error) {
        console.warn(
          `[wecom-b3] active-push-fallback-to-client account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} reason=${options.reason} chunk=${i + 1}/${markdownChunks.length} error=${formatFallbackError(error)}`,
        );
        await sendViaClient(i);
        return;
      }
    }
  };

  interface FinalPushRetryRequest {
    text: string;
    deliveryKey: string;
    peerDedup: boolean;
    appendCompletionMarker: boolean;
  }

  // Bounded retry chain for finals whose fallback push failed. Without it a
  // failed active push after stream expiry silently drops the answer
  // (rollbackFinalDelivered + return). Timers live in this closure, so each
  // req_id/session retries independently; run-time guards keep B3 supersede
  // semantics (a suppressed superseded final is never re-pushed).
  const runFinalPushRetry = async (retry: FinalPushRetryRequest): Promise<void> => {
    if (supersededByNewInbound && suppressSupersededFinalPush) {
      console.info(
        `[wecom-b3] final-retry-skip-superseded account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
      );
      return;
    }
    if (!markFinalDelivered(retry.deliveryKey, { peerDedup: retry.peerDedup })) {
      return;
    }
    try {
      await sendMarkdownChunksViaActivePush(retry.text, {
        reason: "final-retry",
        appendCompletionMarker: retry.appendCompletionMarker,
        progress: resolveFinalPushProgress(retry.text, retry.appendCompletionMarker),
      });
      visibleReplyStarted = true;
      console.info(
        `[wecom-b3] final-retry-delivered attempt=${finalPushRetryCount}/${FINAL_PUSH_MAX_RETRIES} account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
      );
      params.onDeliver?.();
    } catch (error) {
      rollbackFinalDelivered(retry.deliveryKey, { peerDedup: retry.peerDedup });
      console.warn(
        `[wecom-b3] final-retry-failed attempt=${finalPushRetryCount}/${FINAL_PUSH_MAX_RETRIES} account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
      );
      if (finalPushRetryCount >= FINAL_PUSH_MAX_RETRIES) {
        console.warn(
          `[wecom-b3] final-retry-exhausted account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
        );
        params.onFail?.(error);
        return;
      }
      scheduleFinalPushRetry(retry);
    }
  };

  const scheduleFinalPushRetry = (retry: FinalPushRetryRequest): void => {
    if (finalPushRetryTimer || (supersededByNewInbound && suppressSupersededFinalPush)) {
      return;
    }
    if (finalPushRetryCount >= FINAL_PUSH_MAX_RETRIES) {
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
    if (
      !deliveredSourceText ||
      !finalText.startsWith(deliveredSourceText)
    ) {
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
    options: { appendCompletionMarker: boolean },
  ): Promise<boolean> => {
    const markdownChunks = withOptionalCompletionMarker(
      chunkWeComMarkdownV2(
        finalText,
        WECOM_STREAM_FINAL_MAX_CHARS,
        WECOM_STREAM_MAX_BYTES,
      ).map(escapeLiteralThinkTags),
      options.appendCompletionMarker,
    );
    const finalStreamId = resolveStreamId();
    const fallbackText = resolveStreamFallbackText(finalText);
    const firstStreamChunk = markdownChunks[0] ?? "";
    const pendingAckCleared = await waitForPendingReplyAckToClear({
      client: params.client,
      frame: params.frame,
    });
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
        params.onFail?.(fallbackError);
        return false;
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
        params.onFail?.(fallbackError);
        return false;
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
        params.onFail?.(fallbackError);
        return false;
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
          params.onFail?.(fallbackError);
          return false;
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
        params.onFail?.(fallbackError);
        return false;
      }
      return true;
    }

    if (markdownChunks.length > 1) {
      for (let i = 1; i < markdownChunks.length; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        console.info(
          `[wecom-b2] stream-remainder account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId} chunk=${i + 1}/${markdownChunks.length}`,
        );
        await withHandleSendTimeout(
          params.client.sendMessage(peerId, {
            msgtype: "markdown",
            markdown: { content: markdownChunks[i] ?? "" },
          }),
          "stream remainder push",
        );
      }
    }
    return true;
  };

  const renderPreviewText = (text: string, now = Date.now()): string => {
    if (!text) {
      return "";
    }
    const thinkingLimits = resolveThinkingAwareBodyLimits(accumulatedThinkingText);
    previewStartedAt ??= now;
    const elapsedMs = now - previewStartedAt;
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
      return `${frozen}\n\n${formatElapsedStatus(elapsedMs)}`;
    }
    return previewWeComMarkdownV2(text, thinkingLimits.maxChars, thinkingLimits.maxBytes);
  };

  // One-time active push after the frozen preview channel dies (typically
  // errcode 846608 once the WeCom stream window closes at ~6 min). Without
  // it the bubble goes silent forever while the task is still running.
  const maybeSendPreviewExpiredNotice = (): void => {
    if (
      previewExpiredNoticeSent ||
      !previewFrozen ||
      streamSettled ||
      finalDelivered ||
      isEvent ||
      supersededByNewInbound
    ) {
      return;
    }
    previewExpiredNoticeSent = true;
    void sendMarkdownChunksViaActivePush(PREVIEW_EXPIRED_NOTICE_TEXT, {
      reason: "preview-expired",
    })
      .then(() => {
        console.info(
          `[wecom-preview] expired-notice account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
        );
      })
      .catch((error) => {
        console.warn(
          `[wecom-preview] expired-notice-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
        );
      });
  };

  const sendPreviewUpdate = async (
    previewText: string,
    now: number,
    options?: { bodySourceText?: string },
  ): Promise<boolean> => {
    const previewStreamId = resolveStreamId();
    try {
      const result = await withHandleSendTimeout(
        sendNonFinalStreamUpdate({
          client: params.client,
          frame: params.frame,
          streamId: previewStreamId,
          content: previewText,
        }),
        "stream preview",
      );
      if (result === "skipped") {
        console.info(
          `[wecom-preview] update-skipped-pending account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${previewStreamId}`,
        );
        lastPreviewText = previewText;
        lastPreviewUpdateAt = now;
        return false;
      }
    } catch (error) {
      if (isTerminalReplyError(error)) {
        console.warn(
          `[wecom-preview] terminal-update-stopped account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${previewStreamId} error=${formatFallbackError(error)}`,
        );
        streamUpdateUnreliable = true;
        stopPreviewFreezeTimeout();
        stopPreviewStatusInterval();
        maybeSendPreviewExpiredNotice();
        return false;
      }
      console.warn(
        `[wecom-preview] update-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${previewStreamId} error=${formatFallbackError(error)}`,
      );
      return false;
    }

    stopPlaceholderKeepalive();
    visibleReplyStarted = true;
    lastPreviewText = previewText;
    lastPreviewUpdateAt = now;
    if (options?.bodySourceText) {
      lastDeliveredBodySourceText = options.bodySourceText;
    }
    if (previewFrozen) {
      stopPreviewFreezeTimeout();
      lastPreviewStatusAt = now;
      previewFrozenDeliveredSourceText = previewFrozenSourceText;
      startPreviewStatusInterval();
    }
    return true;
  };

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
    if (previewStartedAt !== undefined && now - previewStartedAt >= PREVIEW_WATCHDOG_MAX_MS) {
      previewWatchdogExpired = true;
      console.warn(
        `[wecom-preview] status-watchdog-stopped account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} elapsedMs=${now - previewStartedAt}`,
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
        bodySourceText: accumulatedText || previewFrozenSourceText,
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
    await sendPreviewUpdate(previewText, now, { bodySourceText: accumulatedText });
  };

  const schedulePreviewFreezeTimeout = (now = Date.now()): void => {
    if (
      previewFreezeTimeout ||
      streamSettled ||
      previewFrozen ||
      previewStartedAt === undefined ||
      !lastPreviewText ||
      isEvent ||
      supersededByNewInbound
    ) {
      return;
    }
    const delayMs = Math.max(0, BLOCK_PREVIEW_MAX_MS - (now - previewStartedAt));
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
      ((previewStartedAt !== undefined && now - previewStartedAt >= BLOCK_PREVIEW_MAX_MS) ||
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
      bodySourceText: accumulatedText || undefined,
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
    const delivered = await sendPreviewUpdate(previewText, now, { bodySourceText: text });
    if (delivered && !previewFrozen) {
      schedulePreviewFreezeTimeout(now);
    }
  };

  const closeSupersededPlaceholder = (): void => {
    if (isEvent || supersededNoticeSent || visibleReplyStarted || streamSettled) return;
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
        console.warn(
          `[wecom-b3] supersede-notice-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${noticeStreamId} error=${formatFallbackError(error)}`,
        );
      });
  };

  if (params.autoSendPlaceholder !== false && !isEvent) {
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
    deliver: async (payload: ReplyPayload, info) => {
      // Mark this chat as active on this handle
      notifyPeerActive();

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
      if (info.kind === "final" && mediaUrls.length > 0) {
        const cfg = getWecomRuntime().config.loadConfig();
        const mediaLocalRoots = resolveWecomMergedMediaLocalRoots({ cfg });
        const mediaMaxBytes = resolveWecomMediaMaxBytes(cfg, params.accountId);
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
            if (result.downgradeNote) {
              mediaNotes.push(result.downgradeNote);
            }
            continue;
          }
          mediaFailures.push(formatMediaFailure(mediaUrl, result.error, result.rejectReason));
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
          if (!finalText && reasoningOnlyFinal) {
            finalText = FINAL_COMPLETION_MARKER;
          }
        }
      }
      if (!finalText) {
        return;
      }

      const currentFinalDeliveryKey =
        info.kind === "final"
          ? buildFinalDeliveryKey({
              accountId: params.accountId,
              peerKind,
              peerId: peerKeyId,
              text: finalText,
              mediaUrls,
            })
          : "";
      const currentFinalUsesPeerDedup = info.kind === "final" && !supersededByNewInbound;
      if (
        info.kind === "final" &&
        !markFinalDelivered(currentFinalDeliveryKey, { peerDedup: currentFinalUsesPeerDedup })
      ) {
        return;
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
          if (
            !(await deliverNormalFinalViaStream(finalText, {
              appendCompletionMarker: finalAppendCompletionMarker,
            }))
          ) {
            rollbackFinalDelivered(currentFinalDeliveryKey, {
              peerDedup: currentFinalUsesPeerDedup,
            });
            if (!(supersededByNewInbound && suppressSupersededFinalPush)) {
              scheduleFinalPushRetry({
                text: resolveStreamFallbackText(finalText),
                deliveryKey: currentFinalDeliveryKey,
                peerDedup: currentFinalUsesPeerDedup,
                appendCompletionMarker: true,
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
      const sendFailNoticeOnce = async (): Promise<void> => {
        if (isEvent || finalDelivered || finalPushRetryTimer || failNoticeSent) {
          return;
        }
        failNoticeSent = true;
        console.warn(
          `[wecom-reply] fail-notice account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
        );
        try {
          await sendMarkdownChunksViaActivePush(REPLY_FAIL_NOTICE_TEXT, {
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
      const message = formatErrorMessage(error);
      const text = `WeCom WS reply failed: ${message}`;

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
      supersededAt = Date.now();
      stopPlaceholderKeepalive();
      stopPreviewFreezeTimeout();
      stopPreviewStatusInterval();
      if (suppressSupersededFinalPush && finalPushRetryTimer) {
        // A suppressed superseded final must never be re-pushed; drop the
        // pending retry instead of leaving it to the run-time guard.
        clearTimeout(finalPushRetryTimer);
        finalPushRetryTimer = undefined;
      }
      console.info(
        `[wecom-b3] superseded account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} reason=${meta.reason} pendingAck=${hasPendingReplyAck(params.client, params.frame)}`,
      );
      closeSupersededPlaceholder();
    },
  };
}
