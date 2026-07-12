import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import { prepareInboundSession } from "./session-manager.js";
import { dispatchRuntimeReply } from "./reply-orchestrator.js";
import type { RuntimeStore } from "../store/interfaces.js";
import type { WecomAuditLog } from "../observability/audit-log.js";
import { buildRawEnvelopeSummary } from "../observability/raw-envelope-log.js";
import type { ReplyHandle, UnifiedInboundEvent } from "../types/index.js";
import type { WecomMediaService } from "../shared/media-service.js";
import { registerActiveBotWsReplyHandle, unregisterActiveBotWsReplyHandle } from "../runtime.js";

const PREPARE_INBOUND_SESSION_TIMEOUT_MS = 60_000;
const SUPERSEDED_CORE_QUIET_GRACE_MS = 250;

function createPrepareTimeoutError(timeoutMs: number): Error {
  const error = new Error(`WeCom inbound session prepare timed out after ${timeoutMs}ms`);
  error.name = "WeComPrepareTimeoutError";
  return error;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("WeCom Bot WS reply aborted."));
  }
  let handleAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    handleAbort = () => reject(signal.reason ?? new Error("WeCom Bot WS reply aborted."));
    signal.addEventListener("abort", handleAbort, { once: true });
  });
  const cleanup = () => {
    if (handleAbort) signal.removeEventListener("abort", handleAbort);
  };
  promise.then(cleanup, cleanup);
  return Promise.race([promise, abortPromise]).finally(cleanup);
}

function waitForSupersededCoreQuietGrace(
  supersededAt: number,
  signal: AbortSignal,
): Promise<void> {
  const remainingMs = supersededAt + SUPERSEDED_CORE_QUIET_GRACE_MS - Date.now();
  if (remainingMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("WeCom Bot WS reply aborted."));
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const handleAbort = () => {
      if (timeout) clearTimeout(timeout);
      reject(signal.reason ?? new Error("WeCom Bot WS reply aborted."));
    };
    timeout = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, remainingMs);
    timeout.unref?.();
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

async function prepareInboundSessionWithTimeout(
  params: Parameters<typeof prepareInboundSession>[0] & { abortController: AbortController },
): Promise<Awaited<ReturnType<typeof prepareInboundSession>>> {
  const { abortController, ...prepareParams } = params;
  const abortSignal = abortController.signal;
  const timeout = setTimeout(() => {
    if (!abortSignal.aborted) {
      abortController.abort(createPrepareTimeoutError(PREPARE_INBOUND_SESSION_TIMEOUT_MS));
    }
  }, PREPARE_INBOUND_SESSION_TIMEOUT_MS);
  timeout.unref?.();
  try {
    return await awaitWithAbort(
      prepareInboundSession({ ...prepareParams, abortSignal }),
      abortSignal,
    );
  } finally {
    clearTimeout(timeout);
  }
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
  replyHandle.activate?.();
  auditLog.appendInbound({
    accountId: event.accountId,
    transport: event.transport,
    messageId: event.messageId,
    summary: buildRawEnvelopeSummary(event),
    raw: event.raw,
  });
  store.writeReplyContext(event.messageId, event.replyContext);
  const abortController = new AbortController();
  let obsoleteDispatch = false;
  const abortObsoleteDispatch = (reason: Error): void => {
    obsoleteDispatch = true;
    if (!abortController.signal.aborted) abortController.abort(reason);
  };
  const activeReplyHandle: ReplyHandle = {
    ...replyHandle,
    supersedeByNewInbound: (meta) => {
      try {
        replyHandle.supersedeByNewInbound?.(meta);
      } finally {
        abortObsoleteDispatch(
          new Error("WeCom Bot WS reply aborted: superseded by a newer inbound message."),
        );
      }
    },
  };
  const isBotWsReplySession =
    event.transport === "bot-ws" && replyHandle.context.transport === "bot-ws";
  let sessionKey: string | undefined;
  let supersededPreviousAt: number | undefined;
  let coreDispatchStarted = false;

  if (isBotWsReplySession) {
    console.info(
      `[wecom-b3] dispatch-register-early account=${event.accountId} messageId=${event.messageId} peer=${event.conversation.peerKind}:${event.conversation.peerId}`,
    );
    if (
      registerActiveBotWsReplyHandle({
        accountId: event.accountId,
        peerKind: event.conversation.peerKind,
        peerId: event.conversation.peerId,
        handle: activeReplyHandle,
      })
    ) {
      supersededPreviousAt = Date.now();
    }
  }

  try {
    const session = await prepareInboundSessionWithTimeout({
      core,
      cfg,
      event,
      mediaService,
      abortController,
    });
    sessionKey = session.ctx.SessionKey ?? session.route.sessionKey;
    if (abortController.signal.aborted) return;
    if (supersededPreviousAt !== undefined) {
      await waitForSupersededCoreQuietGrace(
        supersededPreviousAt,
        abortController.signal,
      );
    }
    if (abortController.signal.aborted) return;

    if (isBotWsReplySession) {
      registerActiveBotWsReplyHandle({
        accountId: event.accountId,
        sessionKey,
        peerKind: event.conversation.peerKind,
        peerId: event.conversation.peerId,
        handle: activeReplyHandle,
      });
    }
    console.info(
      `[wecom-b3] dispatch-core-start account=${event.accountId} messageId=${event.messageId} sessionKey=${sessionKey} peer=${event.conversation.peerKind}:${event.conversation.peerId}`,
    );
    coreDispatchStarted = true;
    const dispatchPromise = dispatchRuntimeReply({
      core,
      cfg,
      session,
      replyHandle: activeReplyHandle,
      abortSignal: abortController.signal,
    });
    if (isBotWsReplySession) {
      await awaitWithAbort(dispatchPromise, abortController.signal);
    } else {
      await dispatchPromise;
    }
    console.info(
      `[wecom-b3] dispatch-core-done account=${event.accountId} messageId=${event.messageId} sessionKey=${sessionKey} peer=${event.conversation.peerKind}:${event.conversation.peerId}`,
    );
  } catch (error) {
    if (obsoleteDispatch) {
      console.info(
        `[wecom-b3] dispatch-core-aborted account=${event.accountId} messageId=${event.messageId} sessionKey=${sessionKey ?? "n/a"} peer=${event.conversation.peerKind}:${event.conversation.peerId}`,
      );
      return;
    }
    if (isBotWsReplySession && !coreDispatchStarted) {
      try {
        await activeReplyHandle.fail?.(error);
      } catch (failError) {
        console.warn(
          `[wecom-b3] dispatch-prepare-fail-notice-error account=${event.accountId} messageId=${event.messageId} peer=${event.conversation.peerKind}:${event.conversation.peerId} error=${String(failError)}`,
        );
      }
    }
    throw error;
  } finally {
    if (isBotWsReplySession) {
      unregisterActiveBotWsReplyHandle({
        accountId: event.accountId,
        sessionKey,
        peerKind: event.conversation.peerKind,
        peerId: event.conversation.peerId,
        handle: activeReplyHandle,
      });
    }
  }
}
