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
const WECOM_STREAM_MAX_BYTES = 12_000;
const BLOCK_PREVIEW_MAX_MS = 300_000;
const BLOCK_PREVIEW_MAX_CHARS = 3_000;
const BLOCK_PREVIEW_MIN_UPDATE_MS = 1_500;
const BLOCK_PREVIEW_STATUS_UPDATE_MS = 15_000;
const THINKING_PREVIEW_MIN_UPDATE_MS = 3_000;
const THINKING_BLOCK_MAX_CHARS = 3_000;
const THINKING_BLOCK_MAX_BYTES = 8_000;
const LONG_FINAL_DEDUP_MIN_CHARS = 3_000;
const LONG_FINAL_DEDUP_MIN_BLOCK_CHARS = 500;
const LONG_FINAL_DEDUP_MIN_SEGMENT_CHARS = 120;
const LONG_FINAL_DEDUP_MAX_REMOVALS = 3;
const FINAL_COMPLETION_MARKER = "✅ 已处理完成";
const THINKING_DEBUG_THINK_MARKER = "〔t〕";
const THINKING_DEBUG_BODY_MARKER = "〔b〕";
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

function isTerminalReplyError(error: unknown): boolean {
  return (
    isInvalidReqIdError(error) || isExpiredStreamUpdateError(error) || isAckTimeoutError(error)
  );
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

function normalizeDedupText(value: string): string {
  return value
    .replace(/【消息过长，分段发送：第\d+\/\d+段】/g, "")
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

function addDebugMarker(text: string, marker: string): string {
  if (!text) {
    return "";
  }
  return text.startsWith(marker) ? text : `${marker}\n${text}`;
}

function renderThinkBlock(text: string): string {
  const escaped = trimToUtf8Bytes(
    addDebugMarker(
      escapeThinkBlockText(text).slice(0, THINKING_BLOCK_MAX_CHARS),
      THINKING_DEBUG_THINK_MARKER,
    ),
    THINKING_BLOCK_MAX_BYTES,
  ).trim();
  return escaped ? `<think>${escaped}</think>` : "";
}

function resolveThinkingAwareBodyLimits(thinkingText: string): {
  thinkingBlock: string;
  maxChars: number;
  maxBytes: number;
} {
  const thinkingBlock = renderThinkBlock(thinkingText);
  if (!thinkingBlock) {
    return { thinkingBlock: "", maxChars: WECOM_STREAM_MAX_CHARS, maxBytes: WECOM_STREAM_MAX_BYTES };
  }
  const prefix = `${thinkingBlock}\n`;
  return {
    thinkingBlock,
    maxChars: Math.max(200, WECOM_STREAM_MAX_CHARS - prefix.length),
    maxBytes: Math.max(512, WECOM_STREAM_MAX_BYTES - Buffer.byteLength(prefix, "utf8")),
  };
}

function composeStreamTextWithThinking(params: { thinkingBlock: string; bodyText: string }): string {
  const thinkingBlock = params.thinkingBlock;
  if (!thinkingBlock) {
    return params.bodyText;
  }
  const bodyText = addDebugMarker(params.bodyText, THINKING_DEBUG_BODY_MARKER);
  return bodyText ? `${thinkingBlock}\n${bodyText}` : thinkingBlock;
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
    params.client
      .replyStream(params.frame, resolveStreamId(), placeholderText, false)
      .catch((error) => {
        if (!isTerminalReplyError(error)) {
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
  let previewStartedAt: number | undefined;
  let previewFrozen = false;
  let previewFrozenSourceText = "";
  let previewFrozenDeliveredSourceText = "";
  let previewFrozenText = "";
  let lastPreviewText = "";
  let lastPreviewUpdateAt = 0;
  let lastPreviewStatusAt = 0;

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

  const sendMarkdownChunksViaActivePush = async (
    textToSend: string,
    options: { reason: "superseded-final" | "stream-fallback" },
  ): Promise<void> => {
    const markdownChunks = chunkWeComMarkdownV2(textToSend);
    const pushHandle = getBotWsPushHandle(params.accountId);
    if (pushHandle?.isConnected?.()) {
      for (let i = 0; i < markdownChunks.length; i += 1) {
        const chunk = markdownChunks[i] ?? "";
        console.info(
          `[wecom-b3] active-push account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} reason=${options.reason} chunk=${i + 1}/${markdownChunks.length}`,
        );
        await pushHandle.sendMarkdown(peerId, chunk);
        if (i < markdownChunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
      return;
    }

    for (let i = 0; i < markdownChunks.length; i += 1) {
      const chunk = markdownChunks[i] ?? "";
      console.info(
        `[wecom-b3] client-push account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} reason=${options.reason} chunk=${i + 1}/${markdownChunks.length}`,
      );
      await params.client.sendMessage(peerId, {
        msgtype: "markdown",
        markdown: { content: chunk },
      });
      if (i < markdownChunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
  };

  const resolveStreamFallbackText = (finalText: string): string => {
    if (
      !previewFrozenDeliveredSourceText ||
      !finalText.startsWith(previewFrozenDeliveredSourceText)
    ) {
      return finalText;
    }
    const remainder = finalText.slice(previewFrozenDeliveredSourceText.length).trimStart();
    if (!remainder) {
      return appendFinalCompletionMarker("最终回复已完成，以上预览内容即为完整回复。");
    }
    if (remainder === FINAL_COMPLETION_MARKER) {
      return FINAL_COMPLETION_MARKER;
    }
    return `继续输出：\n\n${remainder}`;
  };

  const deliverNormalFinalViaStream = async (finalText: string): Promise<boolean> => {
    const thinkingLimits = resolveThinkingAwareBodyLimits(accumulatedThinkingText);
    const markdownChunks = chunkWeComMarkdownV2(
      finalText,
      thinkingLimits.maxChars,
      thinkingLimits.maxBytes,
    );
    const finalStreamId = resolveStreamId();
    const fallbackText = resolveStreamFallbackText(finalText);
    const firstStreamChunk = composeStreamTextWithThinking({
      thinkingBlock: thinkingLimits.thinkingBlock,
      bodyText: markdownChunks[0] ?? "",
    });
    try {
      console.info(
        `[wecom-b3] stream-final account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId} chunks=${markdownChunks.length}`,
      );
      await params.client.replyStream(params.frame, finalStreamId, firstStreamChunk, true);
      visibleReplyStarted = true;
    } catch (error) {
      if (isTerminalReplyError(error)) {
        console.warn(
          `[wecom-b3] stream-final-terminal-fallback account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId} error=${formatFallbackError(error)}`,
        );
        try {
          await sendMarkdownChunksViaActivePush(fallbackText, { reason: "stream-fallback" });
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
        await sendMarkdownChunksViaActivePush(fallbackText, { reason: "stream-fallback" });
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
        await params.client.sendMessage(peerId, {
          msgtype: "markdown",
          markdown: { content: markdownChunks[i] ?? "" },
        });
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

  const sendPreviewUpdate = async (previewText: string, now: number): Promise<boolean> => {
    try {
      await params.client.replyStream(params.frame, resolveStreamId(), previewText, false);
    } catch (error) {
      if (isTerminalReplyError(error)) {
        console.warn(
          `[wecom-preview] terminal-update-stopped account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
        );
        settleStream();
        return false;
      }
      console.warn(
        `[wecom-preview] update-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} error=${formatFallbackError(error)}`,
      );
      return false;
    }

    stopPlaceholderKeepalive();
    visibleReplyStarted = true;
    lastPreviewText = previewText;
    lastPreviewUpdateAt = now;
    if (previewFrozen) {
      stopPreviewFreezeTimeout();
      lastPreviewStatusAt = now;
      previewFrozenDeliveredSourceText = previewFrozenSourceText;
      startPreviewStatusInterval();
    }
    return true;
  };

  const renderPreviewStreamText = (bodyText: string): string => {
    const thinkingBlock = renderThinkBlock(accumulatedThinkingText);
    return composeStreamTextWithThinking({
      thinkingBlock,
      bodyText,
    });
  };

  const sendFrozenPreviewStatus = async (): Promise<void> => {
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
      await sendPreviewUpdate(previewText, now);
    } finally {
      previewStatusInFlight = false;
    }
  };

  const startPreviewStatusInterval = (): void => {
    if (previewStatusInterval || streamSettled || !previewFrozen) {
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
    await sendPreviewUpdate(previewText, now);
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

  const deliverBlockPreview = async (text: string): Promise<void> => {
    if (streamSettled || isEvent || supersededByNewInbound || !text) {
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
    const delivered = await sendPreviewUpdate(previewText, now);
    if (delivered && !previewFrozen) {
      schedulePreviewFreezeTimeout(now);
    }
  };

  const closeSupersededPlaceholder = (): void => {
    if (isEvent || supersededNoticeSent || visibleReplyStarted || streamSettled) return;
    supersededNoticeSent = true;
    const noticeStreamId = resolveStreamId();
    void params.client
      .replyStream(params.frame, noticeStreamId, B3_SUPERSEDED_NOTICE_TEXT, true)
      .then(() => {
        console.info(
          `[wecom-b3] supersede-notice account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${noticeStreamId}`,
        );
      })
      .catch((error) => {
        if (!isTerminalReplyError(error)) {
          console.warn(
            `[wecom-b3] supersede-notice-failed account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${noticeStreamId} error=${formatFallbackError(error)}`,
          );
          return;
        }
        params.onFail?.(error);
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
        const now = Date.now();
        const bodyPreviewText = accumulatedText ? renderPreviewText(accumulatedText, now) : "";
        const previewText = renderPreviewStreamText(bodyPreviewText);
        if (!shouldSendThinkingPreview(previewText, now)) {
          return;
        }
        await sendPreviewUpdate(previewText, now);
        return;
      }

      const text = payload.text?.trim() || "";
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
          ? mergeReplyText(accumulatedText, text)
          : accumulatedText || text;

      let finalText = outboundText;
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
        finalText = dedupeLongFinalText(finalText, { previewFrozen });
        if (!isEvent) {
          if (!finalText && accumulatedThinkingText) {
            finalText = FINAL_COMPLETION_MARKER;
          }
          finalText = appendFinalCompletionMarker(finalText);
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
          await params.client.replyWelcome(params.frame, {
            msgtype: "text",
            text: { content: finalText },
          });
        } else if (isEvent) {
          settleStream();
          // Send push message for other events
          await params.client.sendMessage(peerId, {
            msgtype: "markdown",
            markdown: { content: toWeComMarkdownV2(finalText) },
          });
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
            await sendMarkdownChunksViaActivePush(textToSend, { reason: "superseded-final" });
          } catch (error) {
            rollbackFinalDelivered(currentFinalDeliveryKey, {
              peerDedup: currentFinalUsesPeerDedup,
            });
            throw error;
          }
        } else if (info.kind === "final") {
          settleStream();
          if (!(await deliverNormalFinalViaStream(finalText))) {
            rollbackFinalDelivered(currentFinalDeliveryKey, {
              peerDedup: currentFinalUsesPeerDedup,
            });
            return;
          }
        } else {
          stopPlaceholderKeepalive();
          visibleReplyStarted = true;
          await params.client.replyStream(
            params.frame,
            resolveStreamId(),
            renderPreviewStreamText(previewWeComMarkdownV2(finalText)),
            false,
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
      if (isTerminalReplyError(error)) {
        params.onFail?.(error);
        return;
      }
      const message = formatErrorMessage(error);
      const text = `WeCom WS reply failed: ${message}`;

      try {
        if (params.inboundKind === "welcome") {
          await params.client.replyWelcome(params.frame, {
            msgtype: "text",
            text: { content: text },
          });
        } else if (isEvent) {
          await params.client.sendMessage(peerId, {
            msgtype: "markdown",
            markdown: { content: text },
          });
        } else {
          visibleReplyStarted = true;
          await params.client.replyStream(params.frame, resolveStreamId(), text, true);
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
      console.info(
        `[wecom-b3] superseded account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} reason=${meta.reason}`,
      );
      closeSupersededPlaceholder();
    },
  };
}
