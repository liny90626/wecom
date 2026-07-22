import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import type { WecomMediaService } from "../shared/media-service.js";
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
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeCom",
    from: `${event.conversation.peerKind}:${event.conversation.peerId}`,
    previousTimestamp,
    envelope: envelopeOptions,
    body: event.text,
  });

  const firstAttachment = await mediaService.normalizeFirstAttachment(event);
  throwIfAborted(abortSignal);
  const mediaPath = firstAttachment
    ? await mediaService.saveInboundAttachment(event, firstAttachment)
    : undefined;
  throwIfAborted(abortSignal);
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
    RawBody: event.text,
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
    MediaPath: mediaPath,
    MediaUrl: mediaPath,
    MediaType: firstAttachment?.contentType,
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
