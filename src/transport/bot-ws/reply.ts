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

  // Extract peerId for clustering handles
  const body = params.frame.body as any;
  const peerId = String(
    (body?.chattype === "group" ? body?.chatid || body?.from?.userid : body?.from?.userid) ||
      "unknown",
  );
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
    const keepalives = activeKeepalivesByPeer.get(peerId);
    if (keepalives) {
      for (const ka of keepalives) {
        if (ka.reqId === reqId) {
          keepalives.delete(ka);
        }
      }
      if (keepalives.size === 0) {
        activeKeepalivesByPeer.delete(peerId);
      }
    }
  };

  const settleStream = () => {
    if (streamSettled) return;
    streamSettled = true;
    stopPlaceholderKeepalive();
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
    const keepalives = activeKeepalivesByPeer.get(peerId);
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
  let supersededNoticeSent = false;
  let supersededAt: number | undefined;

  const markFinalDelivered = (key: string): boolean => {
    if (finalDelivered) {
      if (key === finalDeliveryKey) {
        console.info(
          `[wecom-b3] final-skip already-delivered account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"}`,
        );
      }
      return false;
    }
    if (shouldSkipRecentPeerFinal(key)) {
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

  const deliverNormalFinalViaStream = async (finalText: string): Promise<void> => {
    const markdownChunks = chunkWeComMarkdownV2(finalText);
    const finalStreamId = resolveStreamId();
    try {
      console.info(
        `[wecom-b3] stream-final account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId} chunks=${markdownChunks.length}`,
      );
      await params.client.replyStream(params.frame, finalStreamId, markdownChunks[0] ?? "", true);
    } catch (error) {
      if (isTerminalReplyError(error)) {
        params.onFail?.(error);
        return;
      }
      console.warn(
        `[wecom-b3] stream-final-fallback account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${finalStreamId} error=${formatFallbackError(error)}`,
      );
      await sendMarkdownChunksViaActivePush(finalText, { reason: "stream-fallback" });
      return;
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
  };

  const closeSupersededPlaceholder = (): void => {
    if (isEvent || supersededNoticeSent) return;
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
    let keepalives = activeKeepalivesByPeer.get(peerId);
    if (!keepalives) {
      keepalives = new Set();
      activeKeepalivesByPeer.set(peerId, keepalives);
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
        accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
      }

      const outboundText =
        info.kind === "final"
          ? accumulatedText
            ? text
              ? `${accumulatedText}\n${text}`
              : accumulatedText
            : text
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
      if (!finalText) {
        return;
      }

      const currentFinalDeliveryKey =
        info.kind === "final"
          ? buildFinalDeliveryKey({
              accountId: params.accountId,
              peerKind,
              peerId,
              text: finalText,
              mediaUrls,
            })
          : "";
      if (info.kind === "final" && !markFinalDelivered(currentFinalDeliveryKey)) {
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
          const textToSend =
            mediaUrls.length > 0 ? `${finalText}\n\n${B3_MEDIA_SUPERSEDED_NOTE}` : finalText;
          console.info(
            `[wecom-b3] superseded-final account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} supersededAt=${supersededAt ?? 0}`,
          );
          await sendMarkdownChunksViaActivePush(textToSend, { reason: "superseded-final" });
        } else if (info.kind === "final") {
          settleStream();
          await deliverNormalFinalViaStream(finalText);
        } else {
          stopPlaceholderKeepalive();
          await params.client.replyStream(
            params.frame,
            resolveStreamId(),
            previewWeComMarkdownV2(finalText),
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
    },
    supersedeByNewInbound: (meta) => {
      if (meta.accountId !== params.accountId || meta.peerKind !== peerKind || meta.peerId !== peerId) {
        return;
      }
      if (supersededByNewInbound) {
        return;
      }
      supersededByNewInbound = true;
      supersededAt = Date.now();
      stopPlaceholderKeepalive();
      console.info(
        `[wecom-b3] superseded account=${params.accountId} peer=${peerKind}:${peerId} reqId=${reqId} streamId=${streamId ?? "n/a"} reason=${meta.reason}`,
      );
      closeSupersededPlaceholder();
    },
  };
}
