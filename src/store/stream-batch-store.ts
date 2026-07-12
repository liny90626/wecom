import crypto from "node:crypto";

import { LIMITS } from "../monitor/limits.js";
import type { PendingInbound, StreamState } from "../types/legacy-stream.js";
import type { WecomBotInboundMessage as WecomInboundMessage } from "../types/index.js";
import type { WecomWebhookTarget } from "../types/runtime-context.js";

const MERGED_ACK_COMPLETED_TEXT = "✅ 已合并处理完成，请查看上一条回复。";
const MERGED_ACK_FAILED_TEXT = "⚠️ 合并处理失败，请查看上一条错误信息或重试。";

function isMediaLikeInbound(msg: WecomInboundMessage): boolean {
  const msgtype = String(msg.msgtype ?? "").trim().toLowerCase();
  if (msgtype === "image" || msgtype === "file" || msgtype === "video") {
    return true;
  }
  if (msgtype !== "mixed") {
    if (msgtype !== "text" && msgtype !== "voice") {
      return false;
    }
    const quote = (msg as any).quote;
    const quoteType = String(quote?.msgtype ?? "").trim().toLowerCase();
    if (quoteType === "image" || quoteType === "file" || quoteType === "video") {
      return Boolean(String(quote?.[quoteType]?.url ?? "").trim());
    }
    const quoteItems = quoteType === "mixed" ? quote?.mixed?.msg_item : undefined;
    return (
      Array.isArray(quoteItems) &&
      quoteItems.some((item: any) => {
        const itemType = String(item?.msgtype ?? "").trim().toLowerCase();
        return (
          ["image", "file", "video"].includes(itemType) &&
          Boolean(String(item?.[itemType]?.url ?? "").trim())
        );
      })
    );
  }
  const items = (msg as any).mixed?.msg_item;
  return (
    Array.isArray(items) &&
    items.some((item: any) =>
      ["image", "file", "video"].includes(
        String(item?.msgtype ?? "").trim().toLowerCase(),
      ),
    )
  );
}

function shouldMergeInitialMediaBatch(
  pending: PendingInbound,
  incomingMsg: WecomInboundMessage,
): boolean {
  return (
    isMediaLikeInbound(incomingMsg) ||
    pending.messages.some((msg) => isMediaLikeInbound(msg))
  );
}

export class StreamStore {
  private streams = new Map<string, StreamState>();
  private msgidToStreamId = new Map<string, string>();
  private pendingInbounds = new Map<string, PendingInbound>();
  private conversationState = new Map<string, { activeBatchKey: string; queue: string[]; nextSeq: number }>();
  private streamIdToBatchKey = new Map<string, string>();
  private batchKeyToStreamIds = new Map<string, Set<string>>();
  private batchStreamIdToAckStreamIds = new Map<string, string[]>();
  private onFlush?: (pending: PendingInbound) => void;

  public setFlushHandler(handler: (pending: PendingInbound) => void) {
    this.onFlush = handler;
  }

  private linkStreamToBatch(streamId: string, batchKey?: string): void {
    const key = String(batchKey ?? "").trim();
    if (!key) return;
    this.streamIdToBatchKey.set(streamId, key);
    const linked = this.batchKeyToStreamIds.get(key) ?? new Set<string>();
    linked.add(streamId);
    this.batchKeyToStreamIds.set(key, linked);
  }

  private unlinkStreamFromBatch(streamId: string, batchKey?: string): void {
    const key = String(batchKey ?? this.streamIdToBatchKey.get(streamId) ?? "").trim();
    this.streamIdToBatchKey.delete(streamId);
    if (!key) return;
    const linked = this.batchKeyToStreamIds.get(key);
    if (!linked) return;
    linked.delete(streamId);
    if (linked.size === 0) {
      this.batchKeyToStreamIds.delete(key);
    } else {
      this.batchKeyToStreamIds.set(key, linked);
    }
  }

  private hasLiveBatchKey(batchKey: string): boolean {
    const key = batchKey.trim();
    if (!key) return false;
    return this.pendingInbounds.has(key) || (this.batchKeyToStreamIds.get(key)?.size ?? 0) > 0;
  }

  private clearPendingTimer(pending?: PendingInbound): void {
    if (!pending?.timeout) return;
    clearTimeout(pending.timeout);
    pending.timeout = null;
  }

  private removePendingBatch(batchKey: string): PendingInbound | undefined {
    const pending = this.pendingInbounds.get(batchKey);
    if (!pending) return undefined;
    this.pendingInbounds.delete(batchKey);
    this.clearPendingTimer(pending);
    pending.readyToFlush = false;
    return pending;
  }

  private removeStreamRecord(streamId: string, state?: StreamState): void {
    const current = state ?? this.streams.get(streamId);
    if (!current) return;
    this.streams.delete(streamId);
    this.unlinkStreamFromBatch(streamId, current.batchKey);
    if (current.msgid && this.msgidToStreamId.get(current.msgid) === streamId) {
      this.msgidToStreamId.delete(current.msgid);
    }
  }

  private pruneAckStreamMappings(): void {
    for (const [batchStreamId, ackIds] of this.batchStreamIdToAckStreamIds.entries()) {
      if (!this.streams.has(batchStreamId)) {
        this.batchStreamIdToAckStreamIds.delete(batchStreamId);
        continue;
      }
      const nextAckIds = ackIds.filter((ackId) => this.streams.has(ackId));
      if (nextAckIds.length === 0) {
        this.batchStreamIdToAckStreamIds.delete(batchStreamId);
        continue;
      }
      this.batchStreamIdToAckStreamIds.set(batchStreamId, nextAckIds);
    }
  }

  private pruneConversationState(): void {
    for (const [convKey, conv] of this.conversationState.entries()) {
      conv.queue = conv.queue.filter((batchKey) => this.pendingInbounds.has(batchKey));
      if (!this.hasLiveBatchKey(conv.activeBatchKey)) {
        const next = conv.queue.shift();
        if (!next) {
          this.conversationState.delete(convKey);
          continue;
        }
        conv.activeBatchKey = next;
        this.conversationState.set(convKey, conv);
        const pending = this.pendingInbounds.get(next);
        if (pending?.readyToFlush) {
          this.flushPending(next);
        }
        continue;
      }
      this.conversationState.set(convKey, conv);
    }
  }

  createStream(params: { msgid?: string; conversationKey?: string; batchKey?: string }): string {
    const streamId = crypto.randomBytes(16).toString("hex");
    if (params.msgid) {
      this.msgidToStreamId.set(String(params.msgid), streamId);
    }
    this.streams.set(streamId, {
      streamId,
      msgid: params.msgid,
      conversationKey: params.conversationKey,
      batchKey: params.batchKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      started: false,
      finished: false,
      content: "",
    });
    this.linkStreamToBatch(streamId, params.batchKey);
    return streamId;
  }

  getStream(streamId: string): StreamState | undefined {
    return this.streams.get(streamId);
  }

  getStreamByMsgId(msgid: string): string | undefined {
    return this.msgidToStreamId.get(String(msgid));
  }

  setStreamIdForMsgId(msgid: string, streamId: string): void {
    const key = String(msgid).trim();
    const value = String(streamId).trim();
    if (!key || !value) return;
    this.msgidToStreamId.set(key, value);
  }

  addAckStreamForBatch(params: { batchStreamId: string; ackStreamId: string }): void {
    const batchStreamId = params.batchStreamId.trim();
    const ackStreamId = params.ackStreamId.trim();
    if (!batchStreamId || !ackStreamId) return;
    const list = this.batchStreamIdToAckStreamIds.get(batchStreamId) ?? [];
    list.push(ackStreamId);
    this.batchStreamIdToAckStreamIds.set(batchStreamId, list);
  }

  drainAckStreamsForBatch(batchStreamId: string): string[] {
    const key = batchStreamId.trim();
    if (!key) return [];
    const list = this.batchStreamIdToAckStreamIds.get(key) ?? [];
    this.batchStreamIdToAckStreamIds.delete(key);
    return list;
  }

  updateStream(streamId: string, mutator: (state: StreamState) => void): void {
    const state = this.streams.get(streamId);
    if (state) {
      mutator(state);
      state.updatedAt = Date.now();
    }
  }

  markStarted(streamId: string): void {
    this.updateStream(streamId, (s) => {
      s.started = true;
    });
  }

  markFinished(streamId: string): void {
    this.updateStream(streamId, (s) => {
      s.finished = true;
    });
  }

  addPendingMessage(params: {
    conversationKey: string;
    target: WecomWebhookTarget;
    msg: WecomInboundMessage;
    msgContent: string;
    nonce: string;
    timestamp: string;
    debounceMs?: number;
  }): { streamId: string; status: "active_new" | "active_merged" | "queued_new" | "queued_merged" } {
    const { conversationKey, target, msg, msgContent, nonce, timestamp, debounceMs } = params;
    const effectiveDebounceMs = debounceMs ?? LIMITS.DEFAULT_DEBOUNCE_MS;

    const state = this.conversationState.get(conversationKey);
    if (!state) {
      const batchKey = conversationKey;
      const streamId = this.createStream({ msgid: msg.msgid, conversationKey, batchKey });
      const pending: PendingInbound = {
        streamId,
        conversationKey,
        batchKey,
        target,
        msg,
        messages: [msg],
        contents: [msgContent],
        msgids: msg.msgid ? [msg.msgid] : [],
        nonce,
        timestamp,
        createdAt: Date.now(),
        timeout: setTimeout(() => {
          this.requestFlush(batchKey);
        }, effectiveDebounceMs),
      };
      this.pendingInbounds.set(batchKey, pending);
      this.conversationState.set(conversationKey, { activeBatchKey: batchKey, queue: [], nextSeq: 1 });
      return { streamId, status: "active_new" };
    }

    const activeBatchKey = state.activeBatchKey;
    const activeIsInitial = activeBatchKey === conversationKey;
    const activePending = this.pendingInbounds.get(activeBatchKey);
    const queuedBatchKey = state.queue.at(-1);
    const canMergeIntoActive =
      activePending &&
      !queuedBatchKey &&
      (!activeIsInitial || shouldMergeInitialMediaBatch(activePending, msg));
    if (activePending && canMergeIntoActive) {
      const activeStream = this.streams.get(activePending.streamId);
      const activeStarted = Boolean(activeStream?.started);
      if (!activeStarted) {
        activePending.contents.push(msgContent);
        activePending.messages.push(msg);
        if (msg.msgid) {
          activePending.msgids.push(msg.msgid);
        }
        if (activePending.timeout) clearTimeout(activePending.timeout);
        activePending.timeout = setTimeout(() => {
          this.requestFlush(activeBatchKey);
        }, effectiveDebounceMs);
        return { streamId: activePending.streamId, status: "active_merged" };
      }
    }

    if (queuedBatchKey) {
      const existingQueued = this.pendingInbounds.get(queuedBatchKey);
      if (existingQueued && !existingQueued.readyToFlush) {
        existingQueued.contents.push(msgContent);
        existingQueued.messages.push(msg);
        if (msg.msgid) {
          existingQueued.msgids.push(msg.msgid);
        }
        if (existingQueued.timeout) clearTimeout(existingQueued.timeout);
        existingQueued.timeout = setTimeout(() => {
          this.requestFlush(queuedBatchKey);
        }, effectiveDebounceMs);
        return { streamId: existingQueued.streamId, status: "queued_merged" };
      }
    }

    const seq = state.nextSeq++;
    const batchKey = `${conversationKey}#q${seq}`;
    state.queue.push(batchKey);
    const streamId = this.createStream({ msgid: msg.msgid, conversationKey, batchKey });
    const pending: PendingInbound = {
      streamId,
      conversationKey,
      batchKey,
      target,
      msg,
      messages: [msg],
      contents: [msgContent],
      msgids: msg.msgid ? [msg.msgid] : [],
      nonce,
      timestamp,
      createdAt: Date.now(),
      timeout: setTimeout(() => {
        this.requestFlush(batchKey);
      }, effectiveDebounceMs),
    };
    this.pendingInbounds.set(batchKey, pending);
    this.conversationState.set(conversationKey, state);
    return { streamId, status: "queued_new" };
  }

  private requestFlush(batchKey: string): void {
    const pending = this.pendingInbounds.get(batchKey);
    if (!pending) return;

    const state = this.conversationState.get(pending.conversationKey);
    const isActive = state?.activeBatchKey === batchKey;
    if (!isActive) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
        pending.timeout = null;
      }
      pending.readyToFlush = true;
      return;
    }
    this.flushPending(batchKey);
  }

  private flushPending(pendingKey: string): void {
    const pending = this.removePendingBatch(pendingKey);
    if (!pending) return;

    if (this.onFlush) {
      this.onFlush(pending);
    }
  }

  cancelPendingForAccount(accountId: string, reason: string): string[] {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId) return [];
    const failureReason = reason.trim() || "WeCom webhook account stopped before batch processing.";
    const cancelled = Array.from(this.pendingInbounds.entries()).filter(
      ([, pending]) => pending.target.account.accountId === normalizedAccountId,
    );

    // Remove all account-owned timers first. Settling an active stream can promote its
    // queued successor, which must not be allowed to flush against the retired target.
    for (const [batchKey] of cancelled) {
      this.removePendingBatch(batchKey);
    }

    const streamIds: string[] = [];
    for (const [, pending] of cancelled) {
      streamIds.push(pending.streamId);
      this.updateStream(pending.streamId, (state) => {
        state.error = state.error || failureReason;
        state.content = state.content || "⚠️ 账号正在重载，本批消息未处理，请稍后重试。";
        state.finished = true;
      });
      this.onStreamFinished(pending.streamId);
    }
    this.pruneConversationState();
    return streamIds;
  }

  onStreamFinished(streamId: string): string[] {
    const batchState = this.streams.get(streamId);
    const batchFailed = Boolean(batchState?.error || batchState?.fallbackMode === "error");
    const ackStreamIds = this.drainAckStreamsForBatch(streamId);
    for (const ackStreamId of ackStreamIds) {
      this.updateStream(ackStreamId, (state) => {
        state.content = batchFailed ? MERGED_ACK_FAILED_TEXT : MERGED_ACK_COMPLETED_TEXT;
        state.finished = true;
      });
    }

    const batchKey = this.streamIdToBatchKey.get(streamId);
    const state = batchKey ? this.streams.get(streamId) : undefined;
    const conversationKey = state?.conversationKey;
    if (!batchKey || !conversationKey) return ackStreamIds;

    this.unlinkStreamFromBatch(streamId, batchKey);

    const conv = this.conversationState.get(conversationKey);
    if (!conv) return ackStreamIds;
    if (conv.activeBatchKey !== batchKey) return ackStreamIds;

    const next = conv.queue.shift();
    if (!next) {
      this.conversationState.delete(conversationKey);
      return ackStreamIds;
    }
    conv.activeBatchKey = next;
    this.conversationState.set(conversationKey, conv);

    const pending = this.pendingInbounds.get(next);
    if (!pending) return ackStreamIds;
    if (pending.readyToFlush) {
      this.flushPending(next);
    }
    return ackStreamIds;
  }

  prune(now: number = Date.now()): void {
    const streamCutoff = now - LIMITS.STREAM_TTL_MS;

    for (const [id, state] of this.streams.entries()) {
      if (state.updatedAt < streamCutoff) {
        if (state.batchKey && !state.finished) {
          state.error = state.error || "WeCom webhook batch expired before completion.";
          state.finished = true;
          this.onStreamFinished(id);
        }
        this.removeStreamRecord(id, state);
      }
    }

    for (const [msgid, id] of this.msgidToStreamId.entries()) {
      if (!this.streams.has(id)) {
        this.msgidToStreamId.delete(msgid);
      }
    }

    for (const [key, pending] of this.pendingInbounds.entries()) {
      if (now - pending.createdAt > LIMITS.STREAM_TTL_MS) {
        this.removePendingBatch(key);
      }
    }

    this.pruneAckStreamMappings();
    this.pruneConversationState();
  }
}
