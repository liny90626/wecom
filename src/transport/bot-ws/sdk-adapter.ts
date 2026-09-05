import crypto from "node:crypto";
import AiBot, {
  generateReqId,
  type BaseMessage,
  type EventMessage,
  type WsFrame,
} from "@wecom/aibot-node-sdk";
import type { WecomAccountRuntime } from "../../app/account-runtime.js";
import {
  registerBotWsPushHandle,
  unregisterBotWsPushHandle,
  type BotWsPushHandle,
} from "../../app/index.js";
import { updateTemplateCardOnEvent } from "../../capability/card/manager.js";
import { clearWecomMcpAccountCache } from "../../capability/mcp/index.js";
import { PLUGIN_VERSION } from "../../version.js";
import type { ReplyHandle, RuntimeLogSink, UnifiedInboundEvent } from "../../types/index.js";
import { mapBotWsFrameToInboundEvent } from "./inbound.js";
import { uploadAndSendBotWsMedia } from "./media.js";
import {
  createBotWsReplyHandle,
  registerBotWsReplyOwner,
  retireBotWsReplyOwner,
} from "./reply.js";
import { createBotWsSessionSnapshot } from "./session.js";

const MEDIA_FIRST_TEXT_MERGE_WINDOW_MS = 1_000;
const STREAM_REQ_ID_CLAIM_LIMIT = 1_024;
// WeCom retires callback streams after roughly six minutes. Cover the one-minute
// session-prepare limit plus scheduling/ACK margin so a live req_id never looks
// reusable; when the bounded claim table is full, unknown ids fail closed to
// active push instead of evicting a stream that can still repaint its bubble.
const STREAM_REQ_ID_CLAIM_TTL_MS = 8 * 60_000;

type MergeCandidateKind = "media" | "text";

type PendingMergeFrame = {
  event: UnifiedInboundEvent;
  frame: WsFrame<BaseMessage | EventMessage>;
  replyHandle: ReplyHandle;
  timer: ReturnType<typeof setTimeout>;
};

type StreamReqIdClaim = {
  messageId: string;
  ownerToken: string;
  expiresAt: number;
};

type ForcedActivePushReason =
  | "claim-capacity"
  | "missing-req-id"
  | "req-id-collision"
  | "req-id-pending-ack";

function hasPendingCallbackReply(
  client: AiBot.WSClient,
  frame: WsFrame<BaseMessage | EventMessage>,
): boolean {
  const candidate = client as AiBot.WSClient & {
    hasPendingReplyAck?: (pendingFrame: WsFrame<BaseMessage | EventMessage>) => boolean;
  };
  if (typeof candidate.hasPendingReplyAck !== "function") {
    return false;
  }
  try {
    return candidate.hasPendingReplyAck(frame);
  } catch {
    return true;
  }
}

function buildInboundPeerKey(event: UnifiedInboundEvent): string {
  return [
    event.accountId,
    event.conversation.peerKind,
    event.conversation.peerId.trim().toLowerCase(),
    event.conversation.senderId.trim().toLowerCase(),
  ].join(":");
}

function isStandaloneMediaEvent(event: UnifiedInboundEvent): boolean {
  const attachments = event.attachments;
  if (!attachments?.length) return false;
  if (
    event.inboundKind === "image" ||
    event.inboundKind === "file" ||
    event.inboundKind === "video"
  ) {
    return true;
  }
  if (event.inboundKind !== "mixed") return false;
  const items = (event.raw.body as any)?.mixed?.msg_item;
  return (
    Array.isArray(items) &&
    !items.some(
      (item: any) =>
        String(item?.msgtype ?? "").toLowerCase() === "text" &&
        String(item?.text?.content ?? "").trim(),
    )
  );
}

/** 企微期望插件回复自身版本的握手事件（只在官方源码里有，文档未写）。 */
const ENTER_CHECK_UPDATE_EVENT = "enter_check_update";
const ENTER_CHECK_UPDATE_REPLY_CMD = "ww_ai_robot_enter_event";

/**
 * 允许进入 agent 通道的事件类型。
 *
 * 官方插件的通用 `event` 处理用的是**白名单**：只放行它认识的几种，其余一律
 * 跳过。本插件此前只精确拦了 `disconnected_event`（v12），于是 `enter_check_update`
 * 这类企微自己会推的事件仍会被当成一条用户消息跑一轮 OpenClaw——正文是
 * `[event:<类型>]`、peer 常常落成 unknown。改用白名单后，将来新出现的事件类型
 * 默认不再误入 agent 通道；需要处理时再显式加进来。
 *
 * `enter_chat` 是本 fork 的欢迎语入口，必须保留。
 */
const DISPATCHABLE_EVENT_TYPES = new Set([
  "enter_chat",
  "template_card_event",
  "auth_change_event",
]);

function resolveFrameEventType(
  frame: WsFrame<BaseMessage | EventMessage>,
): string | undefined {
  const body = frame.body as EventMessage | undefined;
  if (body?.msgtype !== "event") return undefined;
  const eventType = String(body.event?.eventtype ?? "").trim();
  return eventType || undefined;
}

function resolveMergeCandidateKind(event: UnifiedInboundEvent): MergeCandidateKind | undefined {
  if (isStandaloneMediaEvent(event)) return "media";
  if (
    event.inboundKind === "text" &&
    Boolean(event.text.trim()) &&
    !(event.attachments?.length)
  ) {
    return "text";
  }
  return undefined;
}

function mergeMediaAndText(
  mediaEvent: UnifiedInboundEvent,
  textEvent: UnifiedInboundEvent,
): UnifiedInboundEvent {
  const attachments = [...(mediaEvent.attachments ?? []), ...(textEvent.attachments ?? [])];
  return {
    ...textEvent,
    text: textEvent.text.trim() || mediaEvent.text,
    dedupeAliases: [mediaEvent.messageId],
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export class BotWsSdkAdapter {
  private client?: AiBot.WSClient;
  private pushHandle?: BotWsPushHandle;
  private readonly ownerId: string;
  private readonly pendingMergeFrames = new Map<string, PendingMergeFrame>();
  private readonly streamReqIdClaims = new Map<string, StreamReqIdClaim>();

  constructor(
    private readonly runtime: WecomAccountRuntime,
    private readonly log: RuntimeLogSink,
  ) {
    this.ownerId = `${this.runtime.account.accountId}:ws:${crypto.randomUUID().slice(0, 8)}`;
  }

  private resolveForcedActivePushReason(
    reqId: string,
    messageId: string,
    ownerToken: string,
    callbackReplyPending: boolean,
  ): ForcedActivePushReason | undefined {
    const key = reqId.trim();
    if (!key) {
      return "missing-req-id";
    }

    const now = Date.now();
    const existing = this.streamReqIdClaims.get(key);
    if (existing && existing.expiresAt > now) {
      // Preserve the exact original handle, including across a redelivery of
      // the same message. Two live handles must never share one callback lane.
      return existing.ownerToken !== ownerToken ? "req-id-collision" : undefined;
    }
    if (callbackReplyPending) {
      return "req-id-pending-ack";
    }
    if (existing) {
      this.streamReqIdClaims.delete(key);
    }

    if (this.streamReqIdClaims.size >= STREAM_REQ_ID_CLAIM_LIMIT) {
      for (const [claimedReqId, claim] of this.streamReqIdClaims) {
        if (claim.expiresAt <= now) {
          this.streamReqIdClaims.delete(claimedReqId);
        }
      }
      if (this.streamReqIdClaims.size >= STREAM_REQ_ID_CLAIM_LIMIT) {
        return "claim-capacity";
      }
    }

    this.streamReqIdClaims.set(key, {
      messageId,
      ownerToken,
      expiresAt: now + STREAM_REQ_ID_CLAIM_TTL_MS,
    });
    return undefined;
  }

  private isCallbackStreamCurrent(
    reqId: string,
    messageId: string,
    ownerToken: string,
  ): boolean {
    const key = reqId.trim();
    if (!key) {
      return false;
    }
    const claim = this.streamReqIdClaims.get(key);
    return Boolean(
      claim &&
        claim.messageId === messageId &&
        claim.ownerToken === ownerToken &&
        claim.expiresAt > Date.now(),
    );
  }

  start(): void {
    const bot = this.runtime.account.bot;
    if (!bot?.wsConfigured || !bot.ws) {
      throw new Error(`WeCom bot account "${this.runtime.account.accountId}" missing WS config.`);
    }
    this.log.info?.(
      `[wecom-ws] start account=${this.runtime.account.accountId} botId=${bot.ws.botId} wsUrl=default heartbeat=default reconnectInterval=default`,
    );
    const client = new AiBot.WSClient({
      botId: bot.ws.botId,
      secret: bot.ws.secret,
      logger: {
        debug: (message, ...args) =>
          this.log.info?.(`[wecom-ws] ${message} ${args.join(" ")}`.trim()),
        info: (message, ...args) =>
          this.log.info?.(`[wecom-ws] ${message} ${args.join(" ")}`.trim()),
        warn: (message, ...args) =>
          this.log.warn?.(`[wecom-ws] ${message} ${args.join(" ")}`.trim()),
        error: (message, ...args) =>
          this.log.error?.(`[wecom-ws] ${message} ${args.join(" ")}`.trim()),
      },
    });
    this.client = client;
    registerBotWsReplyOwner(this.ownerId);
    const pushHandle: BotWsPushHandle = {
      ownerId: this.ownerId,
      isConnected: () => client.isConnected,
      replyCommand: async ({ cmd, body, headers }) => {
        const replyHeaders = {
          ...(headers ?? {}),
          req_id: headers?.req_id ?? generateReqId("wecom_ws"),
        };
        const result = await client.reply({ headers: replyHeaders }, body ?? {}, cmd);
        this.runtime.touchTransportSession("bot-ws", {
          ownerId: this.ownerId,
          running: true,
          connected: client.isConnected,
          authenticated: client.isConnected,
          lastOutboundAt: Date.now(),
          lastError: undefined,
        });
        return result as unknown as Record<string, unknown>;
      },
      sendMarkdown: async (chatId, content, chatType) => {
        // An omitted chat_type makes WeCom guess, and it guesses group first.
        // The inbound frame already told us which kind of conversation this is,
        // so say it. Callers that genuinely cannot tell leave it off and keep
        // the previous behaviour.
        const body = {
          msgtype: "markdown",
          markdown: { content },
          ...(chatType ? { chat_type: chatType === "group" ? 2 : 1 } : {}),
        };
        await client.sendMessage(chatId, body as Parameters<typeof client.sendMessage>[1]);
        this.runtime.touchTransportSession("bot-ws", {
          ownerId: this.ownerId,
          running: true,
          connected: client.isConnected,
          authenticated: client.isConnected,
          lastOutboundAt: Date.now(),
          lastError: undefined,
        });
      },
      sendMedia: async ({ chatId, mediaUrl, text, mediaLocalRoots, maxBytes }) => {
        const result = await uploadAndSendBotWsMedia({
          wsClient: client,
          chatId,
          mediaUrl,
          mediaLocalRoots,
          maxBytes,
        });
        if (result.ok && text?.trim()) {
          await client.sendMessage(chatId, {
            msgtype: "markdown",
            markdown: { content: text.trim() },
          });
        }
        this.runtime.touchTransportSession("bot-ws", {
          ownerId: this.ownerId,
          running: true,
          connected: client.isConnected,
          authenticated: client.isConnected,
          lastOutboundAt: Date.now(),
          lastError: result.ok ? undefined : result.error,
        });
        return result;
      },
    };
    this.pushHandle = pushHandle;
    registerBotWsPushHandle(this.runtime.account.accountId, pushHandle);

    client.on("connected", () => {
      this.log.info?.(`[wecom-ws] connected account=${this.runtime.account.accountId}`);
      this.runtime.updateTransportSession(
        createBotWsSessionSnapshot({
          accountId: this.runtime.account.accountId,
          ownerId: this.ownerId,
          connected: true,
          authenticated: false,
        }),
      );
    });

    client.on("authenticated", () => {
      this.log.info?.(`[wecom-ws] authenticated account=${this.runtime.account.accountId}`);
      this.runtime.updateTransportSession(
        createBotWsSessionSnapshot({
          accountId: this.runtime.account.accountId,
          ownerId: this.ownerId,
          connected: true,
          authenticated: true,
        }),
      );
    });

    client.on("disconnected", (reason) => {
      clearWecomMcpAccountCache(this.runtime.account.accountId);
      const normalizedReason = String(reason ?? "").toLowerCase();
      const kicked =
        normalizedReason.includes("kick") ||
        normalizedReason.includes("owner") ||
        normalizedReason.includes("replaced");
      this.log.warn?.(
        `[wecom-ws] disconnected account=${this.runtime.account.accountId} kicked=${String(kicked)} reason=${reason ?? "unknown"}`,
      );
      if (kicked) {
        this.runtime.recordOperationalIssue({
          transport: "bot-ws",
          category: "ws-kicked",
          summary: `ws owner lost: ${reason ?? "unknown"}`,
          error: reason ?? "unknown",
        });
      }
      this.runtime.updateTransportSession(
        createBotWsSessionSnapshot({
          accountId: this.runtime.account.accountId,
          ownerId: this.ownerId,
          running: false,
          connected: false,
          authenticated: false,
          lastDisconnectedAt: Date.now(),
          lastError: reason,
        }),
      );
    });

    client.on("reconnecting", (attempt) => {
      this.log.warn?.(
        `[wecom-ws] reconnecting account=${this.runtime.account.accountId} attempt=${attempt}`,
      );
    });

    client.on("error", (error) => {
      this.log.error?.(
        `[wecom-ws] error account=${this.runtime.account.accountId} message=${error.message}`,
      );
      this.runtime.updateTransportSession(
        createBotWsSessionSnapshot({
          accountId: this.runtime.account.accountId,
          ownerId: this.ownerId,
          running: false,
          connected: client.isConnected,
          authenticated: client.isConnected,
          lastError: error.message,
        }),
      );
    });

    const reportFrameError = (
      frame: WsFrame<BaseMessage | EventMessage>,
      error: unknown,
    ): void => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error?.(
        `[wecom-ws] frame handler failed account=${this.runtime.account.accountId} reqId=${frame.headers?.req_id ?? "n/a"} message=${message}`,
      );
      this.runtime.recordOperationalIssue({
        transport: "bot-ws",
        category: "runtime-error",
        messageId: frame.body?.msgid,
        raw: {
          transport: "bot-ws",
          command: frame.cmd,
          headers: frame.headers,
          body: frame.body,
          envelopeType: "ws",
        },
        summary: `bot-ws frame handler crashed reqId=${frame.headers?.req_id ?? "n/a"}`,
        error: message,
      });
      this.runtime.touchTransportSession("bot-ws", {
        ownerId: this.ownerId,
        running: client.isConnected,
        connected: client.isConnected,
        authenticated: client.isConnected,
        lastError: message,
      });
    };

    const dispatchEvent = async (
      event: UnifiedInboundEvent,
      replyHandle: ReplyHandle,
    ): Promise<void> => {
      const botAccount = this.runtime.account.bot;
      if (!botAccount) return;

      const staticWelcomeText =
        event.inboundKind === "welcome" ? botAccount.config.welcomeText?.trim() : undefined;
      if (staticWelcomeText) {
        try {
          this.log.info?.(
            `[wecom-ws] static welcome reply account=${this.runtime.account.accountId} messageId=${event.messageId} peer=${event.conversation.peerKind}:${event.conversation.peerId} len=${staticWelcomeText.length}`,
          );
          await replyHandle.deliver({ text: staticWelcomeText }, { kind: "final" });
          this.log.info?.(
            `[wecom-ws] static welcome delivered account=${this.runtime.account.accountId} messageId=${event.messageId}`,
          );
        } finally {
          // Static welcomes bypass dispatchInboundEvent, so this is the only
          // path whose owner lifecycle is settled by the adapter itself.
          replyHandle.markDispatchSettled?.();
        }
        return;
      }

      await this.runtime.handleEvent(event, replyHandle);
    };

    const flushPendingMergeFrame = async (
      peerKey: string,
      pending: PendingMergeFrame,
    ): Promise<void> => {
      if (this.pendingMergeFrames.get(peerKey) !== pending) return;
      this.pendingMergeFrames.delete(peerKey);
      try {
        await dispatchEvent(pending.event, pending.replyHandle);
      } catch (error) {
        reportFrameError(pending.frame, error);
      }
    };

    const handleFrame = async (frame: WsFrame<BaseMessage | EventMessage>) => {
      const eventType = resolveFrameEventType(frame);
      if (eventType) {
        // 同一机器人同一时刻只允许一条长连接：新连接订阅成功后，这条会先收到
        // 通知再被服务端断开。它和用户事件走同一条 event 通道，却没有发送者、
        // 没有会话，派发出去只会在一条正在终止的连接上跑一轮 agent。也不能重连
        // ——新 owner 会立刻把我们再踢一次。
        if (eventType === "disconnected_event") {
          this.log.warn?.(
            `[wecom-ws] handed-over account=${this.runtime.account.accountId} reason=disconnected_event`,
          );
          this.runtime.recordOperationalIssue({
            transport: "bot-ws",
            category: "ws-kicked",
            summary: "ws handed over: another connection took this bot; no auto-reconnect",
            error: "disconnected_event",
          });
          return;
        }
        // 企微的版本握手：回自己的版本号即可，它不是用户消息。
        if (eventType === ENTER_CHECK_UPDATE_EVENT) {
          void client
            .reply(frame as never, { version: PLUGIN_VERSION }, ENTER_CHECK_UPDATE_REPLY_CMD)
            .catch((error: unknown) => {
              this.log.warn?.(
                `[wecom-ws] enter-check-update reply failed account=${this.runtime.account.accountId} error=${error instanceof Error ? error.message : String(error)}`,
              );
            });
          return;
        }
        if (!DISPATCHABLE_EVENT_TYPES.has(eventType)) {
          this.log.info?.(
            `[wecom-ws] event ignored account=${this.runtime.account.accountId} eventtype=${eventType}`,
          );
          return;
        }
        // 卡片交互回调：先把卡片本身更新掉（禁用控件、提交按钮改「已提交」），
        // 再照常派发给 agent。不更新的话卡片会一直停在可点状态，用户以为没提交成功。
        // 缓存是进程内的，重启后拿不到原卡片，此时只跳过更新、不影响派发。
        if (eventType === "template_card_event") {
          const body = frame.body as EventMessage | undefined;
          void updateTemplateCardOnEvent({
            client,
            frame,
            accountId: this.runtime.account.accountId,
            event: (body?.event as { template_card_event?: never } | undefined)
              ?.template_card_event,
            userId: String((body as { from?: { userid?: string } } | undefined)?.from?.userid ?? "")
              .trim() || undefined,
          }).catch((error: unknown) => {
            this.log.warn?.(
              `[wecom-ws] template-card-update failed account=${this.runtime.account.accountId} error=${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
        // 授权变更：成员刚在后台改过「可使用权限」，手上那份 MCP 配置与会话
        // 可能已经不对应了，作废掉，让下次调用重新拉取。
        if (eventType === "auth_change_event") {
          this.log.info?.(
            `[wecom-ws] auth changed account=${this.runtime.account.accountId} — clearing MCP config cache`,
          );
          clearWecomMcpAccountCache(this.runtime.account.accountId);
        }
      }
      const botAccount = this.runtime.account.bot;
      if (!botAccount) {
        return;
      }
      this.log.info?.(
        `[wecom-ws] frame account=${this.runtime.account.accountId} cmd=${frame.cmd} reqId=${frame.headers.req_id ?? "n/a"}`,
      );
      this.runtime.touchTransportSession("bot-ws", {
        ownerId: this.ownerId,
        running: true,
        connected: client.isConnected,
        authenticated: client.isConnected,
        lastInboundAt: Date.now(),
      });
      const event = mapBotWsFrameToInboundEvent({
        account: botAccount,
        frame,
      });
      const callbackStreamOwnerToken = crypto.randomUUID();
      const forcedActivePushReason = this.resolveForcedActivePushReason(
        frame.headers.req_id ?? "",
        event.messageId,
        callbackStreamOwnerToken,
        hasPendingCallbackReply(client, frame),
      );
      const forceActivePush = forcedActivePushReason !== undefined;
      if (forcedActivePushReason) {
        this.log.warn?.(
          `[wecom-ws] callback-stream-disabled account=${event.accountId} reqId=${frame.headers.req_id ?? "n/a"} messageId=${event.messageId} reason=${forcedActivePushReason} route=active-push`,
        );
      }
      const replyHandle = createBotWsReplyHandle({
        client,
        frame,
        accountId: this.runtime.account.accountId,
        inboundKind: event.inboundKind,
        forceActivePush,
        callbackStreamClaimId: callbackStreamOwnerToken,
        isCallbackStreamCurrent: () =>
          this.isCallbackStreamCurrent(
            frame.headers.req_id ?? "",
            event.messageId,
            callbackStreamOwnerToken,
          ),
        placeholderContent: botAccount.config.streamPlaceholderContent,
        autoSendPlaceholder:
          event.inboundKind === "text" ||
          event.inboundKind === "image" ||
          event.inboundKind === "file" ||
          event.inboundKind === "voice" ||
          event.inboundKind === "mixed",
        deferActivation: true,
        runtimeOwnerId: this.ownerId,
        onDeliver: () => {
          this.runtime.touchTransportSession("bot-ws", {
            ownerId: this.ownerId,
            running: true,
            connected: client.isConnected,
            authenticated: client.isConnected,
            lastOutboundAt: Date.now(),
          });
        },
        onFail: (error) => {
          this.runtime.touchTransportSession("bot-ws", {
            ownerId: this.ownerId,
            running: client.isConnected,
            connected: client.isConnected,
            authenticated: client.isConnected,
            lastError: error instanceof Error ? error.message : String(error),
          });
        },
      });

      const peerKey = buildInboundPeerKey(event);
      const pending = this.pendingMergeFrames.get(peerKey);
      const mergeKind = resolveMergeCandidateKind(event);
      if (pending?.event.messageId === event.messageId) {
        this.log.info?.(
          `[wecom-ws] duplicate pending media ignored account=${event.accountId} peer=${event.conversation.peerKind}:${event.conversation.peerId} messageId=${event.messageId}`,
        );
        return;
      }
      if (pending && mergeKind === "text") {
        clearTimeout(pending.timer);
        this.pendingMergeFrames.delete(peerKey);
        const mergedEvent = mergeMediaAndText(pending.event, event);
        this.log.info?.(
          `[wecom-ws] merged media+text account=${event.accountId} peer=${event.conversation.peerKind}:${event.conversation.peerId} mediaMessageId=${pending.event.messageId} textMessageId=${event.messageId}`,
        );
        // Answer on the media frame's already-acknowledged bubble; the text
        // frame's handle never opened one, so nothing is left dangling.
        await dispatchEvent(mergedEvent, pending.replyHandle);
        return;
      }

      if (pending) {
        clearTimeout(pending.timer);
        // Starting the previous dispatch synchronously preserves arrival order,
        // while leaving its full OpenClaw run to the dispatcher's handoff logic.
        void flushPendingMergeFrame(peerKey, pending);
      }

      if (mergeKind === "media") {
        // Acknowledge before parking: the merge window is pure waiting, and a
        // silent bubble for its whole duration is the slowest thing the user
        // can see after uploading a file.
        replyHandle.startPlaceholder?.();
        let nextPending: PendingMergeFrame;
        const timer = setTimeout(() => {
          void flushPendingMergeFrame(peerKey, nextPending);
        }, MEDIA_FIRST_TEXT_MERGE_WINDOW_MS);
        timer.unref?.();
        nextPending = { event, frame, replyHandle, timer };
        this.pendingMergeFrames.set(peerKey, nextPending);
        return;
      }

      await dispatchEvent(event, replyHandle);
    };

    const runHandleFrame = (frame: WsFrame<BaseMessage | EventMessage>) => {
      void handleFrame(frame).catch((error) => {
        reportFrameError(frame, error);
      });
    };

    client.on("message", (frame) => {
      runHandleFrame(frame);
    });
    client.on("event", (frame) => {
      runHandleFrame(frame);
    });

    client.connect();
  }

  stop(): void {
    this.log.info?.(`[wecom-ws] stop account=${this.runtime.account.accountId}`);
    retireBotWsReplyOwner(this.ownerId);
    for (const pending of this.pendingMergeFrames.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingMergeFrames.clear();
    this.streamReqIdClaims.clear();
    clearWecomMcpAccountCache(this.runtime.account.accountId);
    if (this.pushHandle) {
      unregisterBotWsPushHandle(this.runtime.account.accountId, this.pushHandle);
      this.pushHandle = undefined;
    }
    this.runtime.updateTransportSession(
      createBotWsSessionSnapshot({
        accountId: this.runtime.account.accountId,
        ownerId: this.ownerId,
        running: false,
        connected: false,
        authenticated: false,
        lastDisconnectedAt: Date.now(),
      }),
    );
    this.client?.disconnect();
  }
}
