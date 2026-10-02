import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { WecomInboundMediaTooLargeError, type WecomMediaService } from "../shared/media-service.js";
import type { UnifiedInboundEvent } from "../types/index.js";
import { getPeerContextToken } from "../context-store.js";
import { recordInboundSessionSettled } from "../shared/inbound-session.js";
import { buildWecomContextTarget } from "../target.js";
import { resolveRuntimeRoute } from "./routing-bridge.js";
import { registerWecomSourceSnapshot } from "./source-registry.js";

export type PreparedSession = {
  route: ReturnType<typeof resolveRuntimeRoute>;
  ctx: ReturnType<PluginRuntime["channel"]["reply"]["finalizeInboundContext"]>;
  storePath: string;
};

const COLD_SESSION_METADATA_GRACE_MS = 1_000;
/** Attachments past this many are left out of one turn, as on the webhook path. */
const MAX_INBOUND_ATTACHMENTS = 8;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("WeCom inbound session prepare aborted.");
  }
}

function readContextSessionId(ctx: { SessionId?: string } | Record<string, unknown>): string | undefined {
  const sessionId = "SessionId" in ctx ? ctx.SessionId : undefined;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
}

export async function prepareInboundSession(params: {
  core: PluginRuntime;
  cfg: OpenClawConfig;
  event: UnifiedInboundEvent;
  mediaService: WecomMediaService;
  abortSignal?: AbortSignal;
}): Promise<PreparedSession> {
  const { core, cfg, event, mediaService, abortSignal } = params;
  throwIfAborted(abortSignal);
  const route = resolveRuntimeRoute({ core, cfg, event });
  const source =
    event.transport === "bot-ws"
      ? "bot-ws"
      : event.transport === "agent-callback"
        ? "agent-callback"
        : undefined;
  if (source) {
    registerWecomSourceSnapshot({
      accountId: event.accountId,
      source,
      messageId: event.messageId,
      sessionKey: route.sessionKey,
      peerKind: event.conversation.peerKind,
      peerId: event.conversation.peerId,
      requesterUserId: event.conversation.senderId,
      chatId: event.conversation.peerId,
    });
  }
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  throwIfAborted(abortSignal);

  // Every attachment reaches the agent (a mixed message carries several images,
  // a merged turn several files); the first may already be prefetched.
  const downloads = await Promise.allSettled([
    mediaService.normalizeFirstAttachment(event),
    ...(event.attachments ?? [])
      .slice(1, MAX_INBOUND_ATTACHMENTS)
      .map((attachment) => mediaService.downloadAttachment(event, attachment)),
  ]);
  const media: Array<{ path: string; contentType?: string }> = [];
  let failedCount = 0;
  for (const download of downloads) {
    try {
      if (download.status === "rejected") {
        throw download.reason;
      }
      throwIfAborted(abortSignal);
      if (download.value) {
        media.push({
          path: await mediaService.saveInboundAttachment(event, download.value),
          contentType: download.value.contentType,
        });
      }
    } catch (error) {
      // Too large is the user's to act on, and an abort is no failure: both still
      // end the turn. Any other lost attachment must not take the text typed with
      // it down too: the agent gets the text and learns the file was unreadable.
      if (error instanceof WecomInboundMediaTooLargeError || abortSignal?.aborted) {
        throw error;
      }
      console.warn(
        `[wecom-media] inbound-attachment-failed account=${event.accountId} messageId=${event.messageId} error=${error instanceof Error ? error.message : String(error)}`,
      );
      failedCount += 1;
    }
  }
  const rawBody =
    failedCount > 0
      ? [event.text, `[${failedCount > 1 ? `${failedCount} 个` : ""}附件下载失败，未能读取]`]
          .filter((line) => line.trim())
          .join("\n")
      : event.text;
  throwIfAborted(abortSignal);
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeCom",
    from: `${event.conversation.peerKind}:${event.conversation.peerId}`,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });
  const defaultOriginatingTo =
    event.conversation.peerKind === "group"
      ? `wecom:group:${event.conversation.peerId}`
      : `wecom:user:${event.conversation.peerId}`;
  const contextToken =
    event.transport === "bot-ws"
      ? getPeerContextToken(event.accountId, event.conversation.peerId)
      : undefined;
  const originatingTo = contextToken
    ? buildWecomContextTarget(contextToken)
    : defaultOriginatingTo;
  const providerContext =
    event.transport === "bot-ws"
      ? {
          // Bot WS inbound turns already have a live reply handle bound to the
          // current req_id. Mark the current surface as WeCom so core final text
          // stays on that handle and replaces the placeholder instead of being
          // re-routed as a second active-push message.
          Provider: "wecom" as const,
          Surface: "wecom" as const,
        }
      : {
          Provider: "wecom" as const,
        };

  const ctx = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: event.text,
    From:
      event.conversation.peerKind === "group"
        ? `wecom:group:${event.conversation.peerId}`
        : `wecom:user:${event.conversation.senderId}`,
    To:
      event.conversation.peerKind === "group"
        ? `wecom:group:${event.conversation.peerId}`
        : `wecom:user:${event.conversation.peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: event.conversation.peerKind,
    ConversationLabel: `${event.conversation.peerKind}:${event.conversation.peerId}`,
    SenderName: event.senderName ?? event.conversation.senderId,
    SenderId: event.conversation.senderId,
    // Keep Originating* populated so explicit route-to-origin flows and message
    // tools can still resolve the active peer context when needed.
    ...providerContext,
    OriginatingChannel: "wecom",
    OriginatingTo: originatingTo,
    MessageSid: event.messageId,
    CommandAuthorized: true,
    MediaPath: media[0]?.path,
    MediaUrl: media[0]?.path,
    MediaType: media[0]?.contentType,
    ...(media.length > 1
      ? {
          MediaPaths: media.map((item) => item.path),
          MediaUrls: media.map((item) => item.path),
          MediaTypes: media.map((item) => item.contentType ?? ""),
        }
      : {}),
  });

  if (source) {
    registerWecomSourceSnapshot({
      accountId: event.accountId,
      source,
      messageId: event.messageId,
      sessionKey: ctx.SessionKey ?? route.sessionKey,
      sessionId: readContextSessionId(ctx),
      peerKind: event.conversation.peerKind,
      peerId: event.conversation.peerId,
      requesterUserId: event.conversation.senderId,
      chatId: event.conversation.peerId,
    });
  }

  throwIfAborted(abortSignal);
  await recordInboundSessionSettled(
    core,
    {
      storePath,
      sessionKey: ctx.SessionKey ?? route.sessionKey,
      ctx,
      onRecordError: () => {},
    },
    {
      abortSignal,
      // OpenClaw records metadata as best effort. Only a cold session needs a
      // short ordering grace; making every warm turn wait on the agent-wide
      // store queue lets an unrelated stuck write block message dispatch.
      waitForMetadata: previousTimestamp === undefined,
      timeoutMs: COLD_SESSION_METADATA_GRACE_MS,
      onMetadataTimeout: (error) => {
        console.warn(
          `[wecom-b3] inbound-session-metadata-deferred sessionKey=${ctx.SessionKey ?? route.sessionKey} graceMs=${COLD_SESSION_METADATA_GRACE_MS} error=${error.message}`,
        );
      },
    },
  );
  throwIfAborted(abortSignal);

  return { route, ctx, storePath };
}
