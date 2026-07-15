import crypto from "node:crypto";
import AiBot, {
  generateReqId,
  type BaseMessage,
  type EventMessage,
  type WsFrame,
} from "@wecom/aibot-node-sdk";
import type { WecomAccountRuntime } from "../../app/account-runtime.js";
import { registerBotWsPushHandle, unregisterBotWsPushHandle } from "../../app/index.js";
import { clearWecomMcpAccountCache } from "../../capability/mcp/index.js";
import type { ReplyHandle, RuntimeLogSink, UnifiedInboundEvent } from "../../types/index.js";
import { mapBotWsFrameToInboundEvent } from "./inbound.js";
import { uploadAndSendBotWsMedia } from "./media.js";
import { createBotWsReplyHandle } from "./reply.js";
import { createBotWsSessionSnapshot } from "./session.js";

const MEDIA_TEXT_MERGE_WINDOW_MS = 500;

type PendingMediaFrame = {
  event: UnifiedInboundEvent;
  frame: WsFrame<BaseMessage | EventMessage>;
  replyHandle: ReplyHandle;
  timer: ReturnType<typeof setTimeout>;
};

function buildInboundPeerKey(event: UnifiedInboundEvent): string {
  return `${event.accountId}:${event.conversation.peerKind}:${event.conversation.peerId.trim().toLowerCase()}`;
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

function mergeMediaFollowedByText(
  mediaEvent: UnifiedInboundEvent,
  textEvent: UnifiedInboundEvent,
): UnifiedInboundEvent {
  const attachments = [...(mediaEvent.attachments ?? []), ...(textEvent.attachments ?? [])];
  return {
    ...textEvent,
    text: textEvent.text.trim() || mediaEvent.text,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export class BotWsSdkAdapter {
  private client?: AiBot.WSClient;
  private readonly ownerId: string;
  private readonly pendingMediaFrames = new Map<string, PendingMediaFrame>();

  constructor(
    private readonly runtime: WecomAccountRuntime,
    private readonly log: RuntimeLogSink,
  ) {
    this.ownerId = `${this.runtime.account.accountId}:ws:${crypto.randomUUID().slice(0, 8)}`;
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
    registerBotWsPushHandle(this.runtime.account.accountId, {
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
      sendMarkdown: async (chatId, content) => {
        await client.sendMessage(chatId, {
          msgtype: "markdown",
          markdown: { content },
        });
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
    });

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
        this.log.info?.(
          `[wecom-ws] static welcome reply account=${this.runtime.account.accountId} messageId=${event.messageId} peer=${event.conversation.peerKind}:${event.conversation.peerId} len=${staticWelcomeText.length}`,
        );
        await replyHandle.deliver({ text: staticWelcomeText }, { kind: "final" });
        this.log.info?.(
          `[wecom-ws] static welcome delivered account=${this.runtime.account.accountId} messageId=${event.messageId}`,
        );
        return;
      }

      await this.runtime.handleEvent(event, replyHandle);
    };

    const flushPendingMediaFrame = async (
      peerKey: string,
      pending: PendingMediaFrame,
    ): Promise<void> => {
      if (this.pendingMediaFrames.get(peerKey) !== pending) return;
      this.pendingMediaFrames.delete(peerKey);
      try {
        await dispatchEvent(pending.event, pending.replyHandle);
      } catch (error) {
        reportFrameError(pending.frame, error);
      }
    };

    const handleFrame = async (frame: WsFrame<BaseMessage | EventMessage>) => {
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
      const replyHandle = createBotWsReplyHandle({
        client,
        frame,
        accountId: this.runtime.account.accountId,
        inboundKind: event.inboundKind,
        placeholderContent: botAccount.config.streamPlaceholderContent,
        autoSendPlaceholder:
          event.inboundKind === "text" ||
          event.inboundKind === "image" ||
          event.inboundKind === "file" ||
          event.inboundKind === "voice" ||
          event.inboundKind === "mixed",
        deferActivation: true,
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
      const pendingMedia = this.pendingMediaFrames.get(peerKey);
      if (pendingMedia && event.inboundKind === "text" && event.text.trim()) {
        clearTimeout(pendingMedia.timer);
        this.pendingMediaFrames.delete(peerKey);
        const mergedEvent = mergeMediaFollowedByText(pendingMedia.event, event);
        this.log.info?.(
          `[wecom-ws] merged media+text account=${event.accountId} peer=${event.conversation.peerKind}:${event.conversation.peerId} mediaMessageId=${pendingMedia.event.messageId} textMessageId=${event.messageId}`,
        );
        await dispatchEvent(mergedEvent, replyHandle);
        return;
      }

      if (pendingMedia) {
        clearTimeout(pendingMedia.timer);
        await flushPendingMediaFrame(peerKey, pendingMedia);
      }

      if (isStandaloneMediaEvent(event)) {
        let pending: PendingMediaFrame;
        const timer = setTimeout(() => {
          void flushPendingMediaFrame(peerKey, pending);
        }, MEDIA_TEXT_MERGE_WINDOW_MS);
        timer.unref?.();
        pending = { event, frame, replyHandle, timer };
        this.pendingMediaFrames.set(peerKey, pending);
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
    for (const pending of this.pendingMediaFrames.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingMediaFrames.clear();
    clearWecomMcpAccountCache(this.runtime.account.accountId);
    unregisterBotWsPushHandle(this.runtime.account.accountId);
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
