import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import { prepareInboundSession } from "./session-manager.js";
import { dispatchRuntimeReply } from "./reply-orchestrator.js";
import type { RuntimeStore } from "../store/interfaces.js";
import type { WecomAuditLog } from "../observability/audit-log.js";
import { buildRawEnvelopeSummary } from "../observability/raw-envelope-log.js";
import type { ReplyHandle, UnifiedInboundEvent } from "../types/index.js";
import type { WecomMediaService } from "../shared/media-service.js";
import { registerActiveBotWsReplyHandle, unregisterActiveBotWsReplyHandle } from "../runtime.js";

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String(error.name ?? "") : "";
  const message = "message" in error ? String(error.message ?? "").toLowerCase() : "";
  return name === "AbortError" || message.includes("abort");
}

export async function dispatchInboundEvent(params: {
  core: PluginRuntime;
  cfg: OpenClawConfig;
  store: RuntimeStore;
  auditLog: WecomAuditLog;
  mediaService: WecomMediaService;
  event: UnifiedInboundEvent;
  replyHandle: ReplyHandle;
}): Promise<void> {
  const { core, cfg, store, auditLog, mediaService, event, replyHandle } = params;
  if (!store.markInboundSeen(event)) {
    auditLog.appendOperational({
      accountId: event.accountId,
      transport: event.transport,
      category: "duplicate-inbound",
      messageId: event.messageId,
      summary: buildRawEnvelopeSummary(event),
      raw: event.raw,
    });
    return;
  }
  auditLog.appendInbound({
    accountId: event.accountId,
    transport: event.transport,
    messageId: event.messageId,
    summary: buildRawEnvelopeSummary(event),
    raw: event.raw,
  });
  store.writeReplyContext(event.messageId, event.replyContext);
  const session = await prepareInboundSession({
    core,
    cfg,
    event,
    mediaService,
  });
  const sessionKey = session.ctx.SessionKey ?? session.route.sessionKey;
  const abortController = new AbortController();
  let supersededAbort = false;
  const activeReplyHandle: ReplyHandle = {
    ...replyHandle,
    supersedeByNewInbound: (meta) => {
      replyHandle.supersedeByNewInbound?.(meta);
      if (!abortController.signal.aborted) {
        supersededAbort = true;
        abortController.abort(new Error("WeCom Bot WS reply aborted: superseded by a newer inbound message."));
      }
    },
  };
  console.info(
    `[wecom-b3] dispatch-register account=${event.accountId} messageId=${event.messageId} sessionKey=${sessionKey} peer=${event.conversation.peerKind}:${event.conversation.peerId}`,
  );
  registerActiveBotWsReplyHandle({
    accountId: event.accountId,
    sessionKey,
    peerKind: event.conversation.peerKind,
    peerId: event.conversation.peerId,
    handle: activeReplyHandle,
  });
  try {
    console.info(
      `[wecom-b3] dispatch-core-start account=${event.accountId} messageId=${event.messageId} sessionKey=${sessionKey} peer=${event.conversation.peerKind}:${event.conversation.peerId}`,
    );
    await dispatchRuntimeReply({
      core,
      cfg,
      session,
      replyHandle: activeReplyHandle,
      abortSignal: abortController.signal,
    });
    console.info(
      `[wecom-b3] dispatch-core-done account=${event.accountId} messageId=${event.messageId} sessionKey=${sessionKey} peer=${event.conversation.peerKind}:${event.conversation.peerId}`,
    );
  } catch (error) {
    if (supersededAbort && isAbortLikeError(error)) {
      console.info(
        `[wecom-b3] dispatch-core-aborted account=${event.accountId} messageId=${event.messageId} sessionKey=${sessionKey} peer=${event.conversation.peerKind}:${event.conversation.peerId}`,
      );
      return;
    }
    throw error;
  } finally {
    unregisterActiveBotWsReplyHandle({
      accountId: event.accountId,
      sessionKey,
      peerKind: event.conversation.peerKind,
      peerId: event.conversation.peerId,
      handle: activeReplyHandle,
    });
  }
}
