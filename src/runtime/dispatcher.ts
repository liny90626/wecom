import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import {
  abortAndDrainAgentHarnessRun,
  resolveActiveEmbeddedRunSessionId,
} from "openclaw/plugin-sdk/agent-harness";

import { prepareInboundSession } from "./session-manager.js";
import { dispatchRuntimeReply } from "./reply-orchestrator.js";
import type { RuntimeStore } from "../store/interfaces.js";
import type { WecomAuditLog } from "../observability/audit-log.js";
import { buildRawEnvelopeSummary } from "../observability/raw-envelope-log.js";
import type { ReplyHandle, UnifiedInboundEvent } from "../types/index.js";
import type { WecomMediaService } from "../shared/media-service.js";
import { isRetryableReplySessionAdmissionError } from "../shared/reply-errors.js";
import {
  getActiveBotWsReplyHandle,
  registerActiveBotWsReplyHandle,
  unregisterActiveBotWsReplyHandle,
} from "../runtime.js";

const PREPARE_INBOUND_SESSION_TIMEOUT_MS = 60_000;
const SUPERSEDED_INIT_CONFLICT_RETRY_DELAY_MS = 500;
const SUPERSEDED_RUN_DRAIN_TIMEOUT_MS = 5_000;
const SUPERSEDED_HANDOFF_WAIT_TIMEOUT_MS = 5_000;
const PRE_DISPATCH_RUN_DRAIN_SETTLE_MS = 1_000;

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

function waitForRetryDelay(ms: number, signal: AbortSignal): Promise<void> {
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
    }, ms);
    timeout.unref?.();
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function awaitDrainWithTimeout(
  promise: Promise<void>,
  signal: AbortSignal,
  label: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      console.warn(
        `[wecom-b3] ${label}-wait-timeout timeoutMs=${SUPERSEDED_HANDOFF_WAIT_TIMEOUT_MS}`,
      );
      resolve();
    }, SUPERSEDED_HANDOFF_WAIT_TIMEOUT_MS);
    timeout.unref?.();
  });
  return awaitWithAbort(Promise.race([promise, timeoutPromise]), signal).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function drainSupersededOpenClawRun(params: {
  sessionKey?: string;
  sessionId?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  let sessionId: string | undefined;
  try {
    sessionId =
      (sessionKey ? resolveActiveEmbeddedRunSessionId(sessionKey) : undefined) ??
      params.sessionId?.trim();
  } catch (error) {
    console.warn(
      `[wecom-b3] superseded-run-lookup-failed sessionKey=${sessionKey ?? "n/a"} error=${String(error)}`,
    );
    return;
  }
  if (!sessionId) {
    return;
  }
  try {
    const result = await abortAndDrainAgentHarnessRun({
      sessionId,
      ...(sessionKey ? { sessionKey } : {}),
      settleMs: SUPERSEDED_RUN_DRAIN_TIMEOUT_MS,
      reason: "wecom-new-inbound",
    });
    console.info(
      `[wecom-b3] superseded-run-drain sessionId=${sessionId} sessionKey=${sessionKey ?? "n/a"} drained=${String(result.drained)} forceCleared=${String(result.forceCleared)}`,
    );
  } catch (error) {
    // The existing bounded init-conflict retry remains the fallback when the
    // optional OpenClaw drain surface is unavailable or rejects.
    console.warn(
      `[wecom-b3] superseded-run-drain-failed sessionId=${sessionId} sessionKey=${sessionKey ?? "n/a"} error=${String(error)}`,
    );
  }
}

// OpenClaw ≥2026.7.1 steers a new dispatch into any still-active run for the
// same session and resolves it with nothing delivered. This guard runs right
// before our own core dispatch: it gracefully aborts a lingering run and
// grants a short settle so the new message can own the session. It must NOT
// escalate to forceClear: 2026.7.1 freezes abort for the whole post-turn
// delivery phase, so a refused abort usually means a HEALTHY dispatch is
// finishing — forceClear would stamp it "run_failed" (surfacing the generic
// core failure text in the chat) and, being identity-less, could even kill a
// newer run that reuses the sessionId. If the run outlives the settle window,
// the absorbed-inbound handling in the reply orchestrator covers the UX.
async function drainLingeringOpenClawRunBeforeDispatch(params: {
  sessionKey?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  let activeSessionId: string | undefined;
  try {
    activeSessionId = resolveActiveEmbeddedRunSessionId(sessionKey) ?? undefined;
  } catch (error) {
    console.warn(
      `[wecom-b3] pre-dispatch-run-lookup-failed sessionKey=${sessionKey} error=${String(error)}`,
    );
    return;
  }
  if (!activeSessionId) {
    return;
  }
  console.info(
    `[wecom-b3] pre-dispatch-run-drain sessionKey=${sessionKey} sessionId=${activeSessionId}`,
  );
  try {
    const graceful = await abortAndDrainAgentHarnessRun({
      sessionId: activeSessionId,
      sessionKey,
      settleMs: PRE_DISPATCH_RUN_DRAIN_SETTLE_MS,
      reason: "wecom-new-inbound",
    });
    console.info(
      `[wecom-b3] pre-dispatch-run-drain-result sessionKey=${sessionKey} sessionId=${activeSessionId} aborted=${String(graceful.aborted)} drained=${String(graceful.drained)}`,
    );
  } catch (error) {
    console.warn(
      `[wecom-b3] pre-dispatch-run-drain-failed sessionKey=${sessionKey} sessionId=${activeSessionId} error=${String(error)}`,
    );
  }
}

function resolvePreparedSessionId(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") {
    return undefined;
  }
  const value = (ctx as { SessionId?: unknown }).SessionId;
  const sessionId = typeof value === "string" ? value.trim() : "";
  return sessionId || undefined;
}

async function dispatchRuntimeReplyWithHandoffRetry(params: {
  core: PluginRuntime;
  cfg: OpenClawConfig;
  session: Awaited<ReturnType<typeof prepareInboundSession>>;
  replyHandle: ReplyHandle;
  abortSignal: AbortSignal;
  retryInitConflict: boolean;
}): Promise<void> {
  const { retryInitConflict, replyHandle, ...dispatchParams } = params;
  const firstAttemptHandle: ReplyHandle = retryInitConflict
    ? {
        ...replyHandle,
        fail: async (error) => {
          if (isRetryableReplySessionAdmissionError(error)) return;
          await replyHandle.fail?.(error);
        },
      }
    : replyHandle;
  try {
    await dispatchRuntimeReply({ ...dispatchParams, replyHandle: firstAttemptHandle });
    return;
  } catch (error) {
    if (!retryInitConflict || !isRetryableReplySessionAdmissionError(error)) {
      throw error;
    }
    if (params.abortSignal.aborted) {
      // A superseded dispatch must not drain or retry: by now the sessionKey
      // can already belong to the successor's freshly started run, and a late
      // drain would abort that run mid-flight.
      throw error;
    }
    console.warn(
      `[wecom-b3] dispatch-init-conflict-handoff-retry delayMs=${SUPERSEDED_INIT_CONFLICT_RETRY_DELAY_MS} sessionKey=${params.session.ctx.SessionKey ?? params.session.route.sessionKey}`,
    );
  }
  await drainSupersededOpenClawRun({
    sessionKey: params.session.ctx.SessionKey ?? params.session.route.sessionKey,
    sessionId: resolvePreparedSessionId(params.session.ctx),
  });
  // OpenClaw raises this conflict before starting the agent run, so retrying cannot repeat tools.
  await waitForRetryDelay(SUPERSEDED_INIT_CONFLICT_RETRY_DELAY_MS, params.abortSignal);
  await dispatchRuntimeReply({ ...dispatchParams, replyHandle });
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
  let previousSupersedeDrain: Promise<void> | undefined;
  let preDispatchDrain: Promise<void> | undefined;
  let supersedeDrainStarted = false;
  let supersedeDrainSettled = false;
  let resolveSupersedeDrain!: () => void;
  const supersedeDrain = new Promise<void>((resolve) => {
    resolveSupersedeDrain = resolve;
  });
  const settleSupersedeDrain = (): void => {
    if (supersedeDrainSettled) {
      return;
    }
    supersedeDrainSettled = true;
    // The next message's handoff barrier must also cover an in-flight
    // pre-dispatch drain: its abort call could otherwise land on the
    // successor's freshly started run.
    const dependencies: Promise<unknown>[] = [];
    if (preDispatchDrain) {
      dependencies.push(preDispatchDrain);
    }
    if (previousSupersedeDrain) {
      dependencies.push(previousSupersedeDrain);
    }
    if (dependencies.length > 0) {
      void Promise.allSettled(dependencies).then(resolveSupersedeDrain, resolveSupersedeDrain);
      return;
    }
    resolveSupersedeDrain();
  };
  let sessionKey: string | undefined;
  let sessionId: string | undefined;
  let coreDispatchStarted = false;
  const startSupersedeDrain = (): void => {
    if (supersedeDrainStarted || !obsoleteDispatch) {
      return;
    }
    if (!coreDispatchStarted || !sessionKey) {
      // A message superseded during media/session preparation never entered
      // OpenClaw, so there is no run to drain.
      if (!coreDispatchStarted) {
        settleSupersedeDrain();
      }
      return;
    }
    supersedeDrainStarted = true;
    void drainSupersededOpenClawRun({ sessionKey, sessionId }).then(
      settleSupersedeDrain,
      settleSupersedeDrain,
    );
  };
  const abortObsoleteDispatch = (reason: Error): void => {
    obsoleteDispatch = true;
    if (!abortController.signal.aborted) abortController.abort(reason);
    startSupersedeDrain();
  };
  const activeReplyHandle: ReplyHandle = {
    ...replyHandle,
    waitForSupersede: () => supersedeDrain,
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

  if (isBotWsReplySession) {
    console.info(
      `[wecom-b3] dispatch-register-early account=${event.accountId} messageId=${event.messageId} peer=${event.conversation.peerKind}:${event.conversation.peerId}`,
    );
    const previousHandle = getActiveBotWsReplyHandle({
      accountId: event.accountId,
      peerKind: event.conversation.peerKind,
      peerId: event.conversation.peerId,
    });
    if (
      registerActiveBotWsReplyHandle({
        accountId: event.accountId,
        peerKind: event.conversation.peerKind,
        peerId: event.conversation.peerId,
        handle: activeReplyHandle,
      })
    ) {
      try {
        previousSupersedeDrain = previousHandle?.waitForSupersede?.();
      } catch (error) {
        console.warn(
          `[wecom-b3] superseded-run-drain-handle-failed account=${event.accountId} peer=${event.conversation.peerKind}:${event.conversation.peerId} error=${String(error)}`,
        );
      }
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
    sessionId = resolvePreparedSessionId(session.ctx);
    if (abortController.signal.aborted) {
      startSupersedeDrain();
      return;
    }

    if (previousSupersedeDrain) {
      await awaitDrainWithTimeout(
        previousSupersedeDrain,
        abortController.signal,
        "superseded-run-drain",
      );
      if (abortController.signal.aborted) return;
    }

    if (isBotWsReplySession) {
      registerActiveBotWsReplyHandle({
        accountId: event.accountId,
        sessionKey,
        peerKind: event.conversation.peerKind,
        peerId: event.conversation.peerId,
        handle: activeReplyHandle,
      });
      preDispatchDrain = drainLingeringOpenClawRunBeforeDispatch({ sessionKey });
      await awaitDrainWithTimeout(
        preDispatchDrain,
        abortController.signal,
        "pre-dispatch-run-drain",
      );
      if (abortController.signal.aborted) {
        // A supersede can land in the microtask gap after the drain settles;
        // the superseded message must not start a zombie core dispatch
        // alongside its successor.
        return;
      }
    }
    console.info(
      `[wecom-b3] dispatch-core-start account=${event.accountId} messageId=${event.messageId} sessionKey=${sessionKey} peer=${event.conversation.peerKind}:${event.conversation.peerId}`,
    );
    coreDispatchStarted = true;
    const dispatchPromise = dispatchRuntimeReplyWithHandoffRetry({
      core,
      cfg,
      session,
      replyHandle: activeReplyHandle,
      abortSignal: abortController.signal,
      retryInitConflict: isBotWsReplySession,
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
    if (obsoleteDispatch && !supersedeDrainStarted) {
      settleSupersedeDrain();
    }
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
