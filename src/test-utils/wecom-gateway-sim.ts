/**
 * Faithful in-memory model of `@wecom/aibot-node-sdk@1.0.7`'s reply transport
 * plus the WeCom client's rendering rules, used to reproduce end-user symptoms
 * (missing thinking blocks, blanked progress, answers arriving as new messages)
 * that only appear once ACK latency and the per-req_id serial queue are modeled.
 *
 * Modeled behaviour (see node_modules/@wecom/aibot-node-sdk/dist/index.cjs.js):
 * - `sendReply` keeps ONE FIFO queue per req_id and sends the head frame only.
 * - The head frame waits for an ACK; after `replyAckTimeout` (5000 ms) the SDK
 *   rejects it with `Reply ack timeout (5000ms) for reqId: <id>` and moves on.
 * - `hasPendingReplyAck` is true while a frame is awaiting its ACK.
 * - `replyStreamNonBlocking` resolves `"skipped"` instead of queueing when a
 *   non-final frame would have to wait behind a pending ACK.
 * - A stream frame carries the WHOLE bubble, so the last delivered frame is
 *   what the user sees; `finish: true` closes the bubble.
 */

import type { WSClient } from "@wecom/aibot-node-sdk";

const REPLY_ACK_TIMEOUT_MS = 5_000;

export type SimStreamFrame = {
  reqId: string;
  streamId: string;
  content: string;
  finish: boolean;
};

export type SimChatEntry =
  | {
      kind: "stream";
      reqId: string;
      streamId: string;
      content: string;
      closed: boolean;
      /** Every rendered revision of this bubble, oldest first. */
      history: string[];
    }
  | { kind: "push"; content: string; chatType?: number };

type QueueItem = {
  frame: SimStreamFrame;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export type WecomGatewaySimOptions = {
  /** Milliseconds the gateway takes to ACK a reply frame. */
  ackLatencyMs?: number;
  /** Frames (1-based, per account) whose ACK never arrives. */
  dropAckOnSend?: number[];
  /** Frames (1-based) the gateway rejects with an errcode. */
  rejectOnSend?: Array<{ index: number; errcode: number; errmsg: string }>;
  /**
   * Closes the stream window this long after the first frame, after which every
   * frame is rejected with 846608 — how WeCom actually retires a ~6-minute
   * stream, rather than at a frame index a test would have to guess.
   */
  rejectAfterMs?: number;
};

/**
 * Simulated WeCom gateway + client. `chat` is what the user would actually see.
 */
export class WecomGatewaySim {
  readonly chat: SimChatEntry[] = [];
  readonly sentFrames: SimStreamFrame[] = [];
  readonly skipped: SimStreamFrame[] = [];
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly pendingAcks = new Map<
    string,
    { item: QueueItem; timer: ReturnType<typeof setTimeout> }
  >();
  private sendCount = 0;
  private firstSendAtMs: number | undefined;

  constructor(private readonly options: WecomGatewaySimOptions = {}) {}

  get ackLatencyMs(): number {
    return this.options.ackLatencyMs ?? 50;
  }

  /** The bubble the user is currently looking at for this req_id. */
  streamBubble(reqId: string): SimChatEntry | undefined {
    for (let i = this.chat.length - 1; i >= 0; i -= 1) {
      const entry = this.chat[i];
      if (entry?.kind === "stream" && entry.reqId === reqId) {
        return entry;
      }
    }
    return undefined;
  }

  /** Everything the user sees, newest last, as plain strings. */
  visibleText(): string[] {
    return this.chat.map((entry) => entry.content);
  }

  hasPendingReplyAck(frame: { headers?: { req_id?: string } }): boolean {
    return this.pendingAcks.has(frame.headers?.req_id ?? "");
  }

  replyStream(
    frame: { headers?: { req_id?: string } },
    streamId: string,
    content: string,
    finish = false,
  ): Promise<unknown> {
    const reqId = frame.headers?.req_id ?? "";
    return new Promise((resolve, reject) => {
      const item: QueueItem = {
        frame: { reqId, streamId, content, finish },
        resolve,
        reject,
      };
      const queue = this.queues.get(reqId) ?? [];
      queue.push(item);
      this.queues.set(reqId, queue);
      if (queue.length === 1) {
        this.processQueue(reqId);
      }
    });
  }

  replyStreamNonBlocking(
    frame: { headers?: { req_id?: string } },
    streamId: string,
    content: string,
    finish = false,
  ): Promise<unknown> {
    if (!finish && this.hasPendingReplyAck(frame)) {
      this.skipped.push({ reqId: frame.headers?.req_id ?? "", streamId, content, finish });
      return Promise.resolve("skipped");
    }
    return this.replyStream(frame, streamId, content, finish);
  }

  async sendMessage(
    _chatId: string,
    body: { markdown?: { content?: string }; chat_type?: number },
  ): Promise<unknown> {
    this.chat.push({
      kind: "push",
      content: body.markdown?.content ?? "",
      ...(body.chat_type === undefined ? {} : { chatType: body.chat_type }),
    });
    return {};
  }

  async replyWelcome(): Promise<unknown> {
    return {};
  }

  private processQueue(reqId: string): void {
    const queue = this.queues.get(reqId);
    if (!queue || queue.length === 0) {
      this.queues.delete(reqId);
      return;
    }
    const item = queue[0]!;
    this.sendCount += 1;
    const sendIndex = this.sendCount;
    this.sentFrames.push(item.frame);
    this.firstSendAtMs ??= Date.now();
    const windowClosed =
      this.options.rejectAfterMs !== undefined &&
      Date.now() - this.firstSendAtMs >= this.options.rejectAfterMs;
    const rejection =
      this.options.rejectOnSend?.find((entry) => entry.index === sendIndex) ??
      (windowClosed
        ? { index: sendIndex, errcode: 846608, errmsg: "stream message update expired" }
        : undefined);
    const dropped = this.options.dropAckOnSend?.includes(sendIndex) === true;

    const handleAck = (deliver: boolean): void => {
      // The gateway applies the frame that actually produced this ACK. The SDK,
      // however, correlates only by req_id, so a late ACK can settle the newer
      // queue head after the older item already timed out.
      if (deliver) {
        this.renderStreamFrame(item.frame);
      }
      const pending = this.pendingAcks.get(reqId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingAcks.delete(reqId);
      queue.shift();
      if (deliver) {
        pending.item.resolve({ errcode: 0 });
      } else if (rejection) {
        pending.item.reject({ errcode: rejection.errcode, errmsg: rejection.errmsg });
      }
      this.processQueue(reqId);
    };

    const ackTimer = setTimeout(() => {
      const pending = this.pendingAcks.get(reqId);
      if (!pending || pending.item !== item) {
        return;
      }
      this.pendingAcks.delete(reqId);
      queue.shift();
      item.reject(new Error(`Reply ack timeout (${REPLY_ACK_TIMEOUT_MS}ms) for reqId: ${reqId}`));
      this.processQueue(reqId);
    }, REPLY_ACK_TIMEOUT_MS);
    ackTimer.unref?.();
    this.pendingAcks.set(reqId, { item, timer: ackTimer });
    if (dropped) {
      return;
    }
    const ackDelay = setTimeout(() => handleAck(!rejection), this.ackLatencyMs);
    ackDelay.unref?.();
  }

  private renderStreamFrame(frame: SimStreamFrame): void {
    const existing = this.streamBubble(frame.reqId);
    if (existing && existing.kind === "stream" && !existing.closed) {
      existing.content = frame.content;
      existing.streamId = frame.streamId;
      existing.closed = frame.finish;
      existing.history.push(frame.content);
      return;
    }
    this.chat.push({
      kind: "stream",
      reqId: frame.reqId,
      streamId: frame.streamId,
      content: frame.content,
      closed: frame.finish,
      history: [frame.content],
    });
  }
}

/**
 * Exposes the simulator as the subset of `WSClient` the reply handle uses. The
 * cast is confined here so tests never repeat it.
 */
export function asWsClient(sim: WecomGatewaySim): WSClient {
  return {
    replyStream: sim.replyStream.bind(sim),
    replyStreamNonBlocking: sim.replyStreamNonBlocking.bind(sim),
    hasPendingReplyAck: sim.hasPendingReplyAck.bind(sim),
    sendMessage: sim.sendMessage.bind(sim),
    replyWelcome: sim.replyWelcome.bind(sim),
  } as unknown as WSClient;
}
