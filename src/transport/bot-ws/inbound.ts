import type { BaseMessage, EventMessage, WsFrame } from "@wecom/aibot-node-sdk";

import {
  describeTemplateCardEvent,
  type TemplateCardEventPayload,
} from "../../capability/card/manager.js";
import { buildInboundBody } from "../bot-webhook/message-shape.js";
import { escapeInternalRuntimeContextDelimiters } from "../../shared/internal-runtime-context.js";
import type {
  ResolvedBotAccount,
  UnifiedInboundEvent,
  WecomBotInboundMessage,
  WecomInboundKind,
} from "../../types/index.js";

function resolveInboundKind(message: BaseMessage | EventMessage): WecomInboundKind {
  if (message.msgtype === "event") {
    const eventType = String((message as EventMessage).event?.eventtype ?? "").trim();
    if (eventType === "enter_chat") return "welcome";
    if (eventType === "template_card_event") return "template-card-event";
    return "event";
  }
  switch (message.msgtype) {
    case "image":
      return "image";
    case "file":
      return "file";
    case "voice":
      return "voice";
    case "video":
      return "video";
    case "mixed":
      return "mixed";
    default:
      return "text";
  }
}

function pushAttachment(
  list: NonNullable<UnifiedInboundEvent["attachments"]>,
  name: "image" | "file" | "video",
  remoteUrl?: string,
  aesKey?: string,
): void {
  if (!remoteUrl) {
    return;
  }
  list.push({ name, remoteUrl, aesKey });
}

function resolveEventText(message: BaseMessage | EventMessage, account: ResolvedBotAccount): string {
  if (message.msgtype !== "event") {
    return buildInboundBody(message as WecomBotInboundMessage);
  }

  const event = message as EventMessage;
  if (event.event?.eventtype === "enter_chat" && account.config.welcomeText) {
    return account.config.welcomeText;
  }
  if (event.event?.eventtype === "template_card_event") {
    // A card interaction IS the answer to a question this bot asked. Handing the
    // model `[event:template_card_event]` made it reply "已收到 … 事件" and the
    // person who asked never learned what was picked.
    const described = describeTemplateCardEvent({
      accountId: account.accountId,
      event: (event.event as { template_card_event?: TemplateCardEventPayload })
        .template_card_event,
    });
    if (described) {
      return described;
    }
  }
  return `[event:${String(event.event?.eventtype ?? "unknown")}]`;
}

export function mapBotWsFrameToInboundEvent(params: {
  account: ResolvedBotAccount;
  frame: WsFrame<BaseMessage | EventMessage>;
}): UnifiedInboundEvent {
  const { account, frame } = params;
  const body = frame.body;
  if (!body) {
    throw new Error("Bot WS frame body is required");
  }
  const peerKind = body.chattype === "group" ? "group" : "direct";
  const senderId = body.from?.userid ?? "unknown";
  const peerId = peerKind === "group" ? body.chatid ?? senderId : senderId;
  const inboundKind = resolveInboundKind(body);

  let attachments: UnifiedInboundEvent["attachments"];
  const collected: NonNullable<UnifiedInboundEvent["attachments"]> = [];
  if (body.msgtype === "image") {
    pushAttachment(collected, "image", (body as any).image?.url, (body as any).image?.aeskey);
  } else if (body.msgtype === "file") {
    pushAttachment(collected, "file", (body as any).file?.url, (body as any).file?.aeskey);
  } else if (body.msgtype === "video") {
    pushAttachment(collected, "video", (body as any).video?.url, (body as any).video?.aeskey);
  } else if (body.msgtype === "mixed") {
    const items = (body as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      for (const item of items) {
        const itemType = String(item.msgtype ?? "").toLowerCase();
        if (itemType === "image") {
          pushAttachment(collected, "image", item.image?.url, item.image?.aeskey);
        } else if (itemType === "file") {
          pushAttachment(collected, "file", item.file?.url, item.file?.aeskey);
        } else if (itemType === "video") {
          pushAttachment(collected, "video", item.video?.url, item.video?.aeskey);
        }
      }
    }
  }

  // 新增支持：如果没有顶层媒体，尝试从引用中提取媒体附件
  // 优先级：quote.image/file/video 优先，其次 quote.mixed 中第一个图片
  if (collected.length === 0) {
    const quote = (body as any).quote;
    if (quote) {
      const quoteType = String(quote.msgtype ?? "").toLowerCase();
      // 处理单个媒体类型的引用
      if (quoteType === "image") {
        pushAttachment(collected, "image", quote.image?.url, quote.image?.aeskey);
      } else if (quoteType === "file") {
        pushAttachment(collected, "file", quote.file?.url, quote.file?.aeskey);
      } else if (quoteType === "video") {
        pushAttachment(collected, "video", quote.video?.url, quote.video?.aeskey);
      } 
      // 处理图文混合类型：只提取第一个图片以保持与 webhook 一致
      else if (quoteType === "mixed" && Array.isArray(quote.mixed?.msg_item)) {
        for (const item of quote.mixed.msg_item) {
          const itemType = String(item.msgtype ?? "").toLowerCase();
          if (itemType === "image") {
            pushAttachment(collected, "image", item.image?.url, item.image?.aeskey);
            break;
          }
        }
      }
    }
  }

  if (collected.length > 0) {
    attachments = collected;
  }

  return {
    accountId: account.accountId,
    capability: "bot",
    transport: "bot-ws",
    inboundKind,
    messageId: body.msgid,
    conversation: {
      accountId: account.accountId,
      peerKind,
      peerId,
      senderId,
    },
    senderName: senderId,
    // Untrusted text: a fenced runtime-context block typed by the user would
    // otherwise reach the model as trusted context (see shared/internal-runtime-context).
    text: escapeInternalRuntimeContextDelimiters(resolveEventText(body, account)),
    timestamp: typeof body.create_time === "number" ? body.create_time : Date.now(),
    raw: {
      transport: "bot-ws",
      command: frame.cmd,
      headers: frame.headers,
      body,
      envelopeType: "ws",
    },
    replyContext: {
      transport: "bot-ws",
      accountId: account.accountId,
      reqId: frame.headers.req_id,
      raw: {
        transport: "bot-ws",
        command: frame.cmd,
        headers: frame.headers,
        body,
        envelopeType: "ws",
      },
    },
    ...(attachments && { attachments }),
  };
}
