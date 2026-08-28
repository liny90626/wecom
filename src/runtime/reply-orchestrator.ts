import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness";
import { hasVisibleReplyBody } from "../shared/reply-visibility.js";
import type { ReplyHandle, ReplyPayload } from "../types/index.js";
import type { PreparedSession } from "./session-manager.js";

type DispatchReply = PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"];
type ReplyOptions = NonNullable<Parameters<DispatchReply>[0]["replyOptions"]>;
type CompatibleReplyOptions = ReplyOptions & {
  // Added in 2026.7.1. Older cores ignore the extra runtime option.
  onTurnAdopted?: () => void | Promise<void>;
};

// Progress callbacks are intentionally detached from OpenClaw's model stream,
// but the detached lane still needs ordering at turn close. Keep the barrier
// short so a broken ACK cannot hold the actual reply indefinitely.
const DETACHED_PROGRESS_DRAIN_GRACE_MS = 500;
// Bounded memory for the narration log of a very long run. Overflow drops the
// oldest steps and is reported downstream so the record can say so.
const PREAMBLE_LOG_MAX_STEPS = 200;

// Two different outcomes, two different truths: the busy notice is only for an
// inbound OpenClaw provably refused (dispatch admission released it), while an
// inbound OpenClaw steered/queued into the running turn was accepted — telling
// that user to resend duplicates model work and tool side effects.
export const BOT_WS_BUSY_INBOUND_NOTICE_TEXT =
  "之前任务还在处理中，新指令冲突啦，请先等待当前任务结束；确认新指令未执行后再重试。";
const BOT_WS_ABSORBED_INBOUND_NOTICE_TEXT =
  "⏳ 上一轮任务仍在进行，本条消息已并入当前任务，完成后一并回复；若长时间未收到回复，请重新发送。";

export class WeComReplyNoVisibleOutputError extends Error {
  constructor(sessionKey?: string) {
    super(`WeCom Bot WS reply produced no visible output${sessionKey ? ` for ${sessionKey}` : ""}.`);
    this.name = "WeComReplyNoVisibleOutputError";
  }
}

export class WeComReplyBusyNotAcceptedError extends Error {
  constructor(sessionKey?: string) {
    super(`OpenClaw did not accept the WeCom inbound while the session was busy${sessionKey ? ` for ${sessionKey}` : ""}.`);
    this.name = "WeComReplyBusyNotAcceptedError";
  }
}

function resolveActiveRunSessionId(sessionKey: string): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  try {
    return resolveActiveEmbeddedRunSessionId(sessionKey) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function dispatchReplyPayload(params: {
  replyHandle: ReplyHandle;
  payload: ReplyPayload;
  kind: "block" | "final";
}): Promise<void> {
  await params.replyHandle.deliver(params.payload, { kind: params.kind });
}

function isFastProgress(payload: ReplyPayload): boolean {
  return payload.channelData?.openclawProgressKind === "fast-mode-auto";
}

export async function dispatchRuntimeReply(params: {
  core: PluginRuntime;
  cfg: OpenClawConfig;
  session: PreparedSession;
  replyHandle: ReplyHandle;
  abortSignal?: AbortSignal;
  retryFlaglessBusy?: boolean;
}): Promise<void> {
  const { core, cfg, session, replyHandle, abortSignal, retryFlaglessBusy } = params;
  const isBotWsReply = replyHandle.context.transport === "bot-ws";
  const sessionKey = String(session.ctx.SessionKey ?? session.route?.sessionKey ?? "");
  let visibleBodySeen = false;
  let visibleProcessPreviewSeen = false;
  let deferredTurn = false;
  let finalDelivered = false;
  let observedReplyDelivery = false;
  let turnAdopted = false;
  let agentRunStarted = false;
  let runActivityObserved = false;
  let fastOffPending = false;
  let fastOffEmptyFinalSuppressed = false;
  let fastAutoOnText = "";
  let blockDeliveryError: unknown;
  let finalDeliveryError: unknown;
  let toolDeliveryError: unknown;

  let progressAccepting = isBotWsReply;
  let progressCancelled = false;
  let progressPendingCount = 0;
  let progressTail = Promise.resolve();
  let progressSealPromise: Promise<void> | undefined;
  let pendingReasoningSlot: { payload: ReplyPayload } | undefined;
  let pendingPreambleSlot: { payload?: ReplyPayload } | undefined;
  // The run's narration as an ordered step log. OpenClaw's CLI backend flushes
  // the narration before each tool call as a one-shot commentary item with a
  // fresh id, so the segments in arrival order ARE the process record. Only
  // the newest entry may still change: a re-flush carrying the same text (or a
  // prefix-extension of it) is the same narration crossing a flush boundary,
  // not a new step.
  const preambleSteps: Array<{ itemId?: string; text: string }> = [];
  let preambleDroppedStepCount = 0;
  let lastPreambleSnapshot = "";

  const updateFastProgressState = (payload: ReplyPayload): boolean => {
    const text = payload.text?.trim() ?? "";
    if (!text) {
      return false;
    }
    const isAutoOn = /\bauto-on\b/i.test(text);
    if (isAutoOn) {
      fastOffPending = false;
      fastOffEmptyFinalSuppressed = false;
      fastAutoOnText = text;
    } else {
      fastOffPending = true;
      fastOffEmptyFinalSuppressed = false;
      fastAutoOnText = "";
    }
    return true;
  };

  const recordProgressDeliveryError = (error: unknown, kind: "block" | "tool"): void => {
    if (abortSignal?.aborted) {
      return;
    }
    if (kind === "tool") {
      toolDeliveryError ??= error;
    } else {
      blockDeliveryError ??= error;
    }
    console.warn(
      `[wecom-b3] progress-delivery-failed sessionKey=${sessionKey} kind=${kind} error=${String(error)}`,
    );
  };

  const appendProgress = (
    resolvePayload: () => ReplyPayload | undefined,
    errorKind: "block" | "tool",
    onDelivered?: () => void,
  ): void => {
    if (!progressAccepting || abortSignal?.aborted) {
      return;
    }
    progressPendingCount += 1;
    const deliverProgress = async (): Promise<void> => {
      if (progressCancelled || abortSignal?.aborted) {
        return;
      }
      try {
        const payload = resolvePayload();
        if (!payload) {
          return;
        }
        await dispatchReplyPayload({ replyHandle, payload, kind: "block" });
        onDelivered?.();
      } catch (error) {
        recordProgressDeliveryError(error, errorKind);
      }
    };
    progressTail = (progressPendingCount === 1
      ? deliverProgress()
      : progressTail.then(deliverProgress)
    ).finally(() => {
      progressPendingCount = Math.max(0, progressPendingCount - 1);
    });
  };

  const enqueueReasoning = (payload: ReplyPayload): void => {
    if (!progressAccepting || abortSignal?.aborted) {
      return;
    }
    freezePendingPreamble();
    if (pendingReasoningSlot) {
      pendingReasoningSlot.payload = payload;
      return;
    }
    const slot = { payload };
    pendingReasoningSlot = slot;
    appendProgress(() => {
      if (pendingReasoningSlot === slot) {
        pendingReasoningSlot = undefined;
      }
      return slot.payload;
    }, "block");
  };

  const enqueueProgress = (payload: ReplyPayload, errorKind: "block" | "tool"): void => {
    pendingReasoningSlot = undefined;
    freezePendingPreamble();
    appendProgress(() => payload, errorKind);
  };

  const resolvePreamblePayload = (): ReplyPayload | undefined => {
    const logText = preambleSteps.map((step) => step.text).join("\n");
    if (!logText || logText === lastPreambleSnapshot) {
      return undefined;
    }
    lastPreambleSnapshot = logText;
    return {
      text: logText,
      channelData: {
        openclawProgressKind: "preamble",
        openclawProgressSteps: preambleSteps.map((step) => step.text),
        openclawProgressDroppedSteps: preambleDroppedStepCount,
      },
    };
  };

  function freezePendingPreamble(): void {
    if (!pendingPreambleSlot) {
      return;
    }
    pendingPreambleSlot.payload ??= resolvePreamblePayload();
    pendingPreambleSlot = undefined;
  }

  const enqueuePreamble = (payload: { itemId?: string; progressText?: string }): boolean => {
    const text = payload.progressText?.trim() ?? "";
    if (!progressAccepting || abortSignal?.aborted || !text) {
      return false;
    }
    const itemId = typeof payload.itemId === "string" && payload.itemId ? payload.itemId : undefined;
    let known: { itemId?: string; text: string } | undefined;
    if (itemId) {
      for (let i = preambleSteps.length - 1; i >= 0; i -= 1) {
        if (preambleSteps[i]?.itemId === itemId) {
          known = preambleSteps[i];
          break;
        }
      }
    }
    const last = preambleSteps.at(-1);
    if (known) {
      // The same item narrating on: its step text is replaced in place.
      if (known.text === text) {
        return true;
      }
      known.text = text;
    } else if (last && last.text === text) {
      // A fresh item id re-flushing the previous text is the same narration
      // crossing a tool-call flush boundary — one step, not two. The new id is
      // NOT adopted: if that item later diverges to different text, it is its
      // own step rather than a rewrite of this one.
      return true;
    } else if (last && text.startsWith(last.text)) {
      // A fresh item id extending the previous text is the same narration
      // continuing; the id moves with it so its updates keep landing here.
      last.itemId = itemId ?? last.itemId;
      last.text = text;
    } else {
      preambleSteps.push({ itemId, text });
      if (preambleSteps.length > PREAMBLE_LOG_MAX_STEPS) {
        preambleSteps.shift();
        preambleDroppedStepCount += 1;
      }
    }
    pendingReasoningSlot = undefined;
    if (pendingPreambleSlot) {
      return true;
    }
    const slot: { payload?: ReplyPayload } = {};
    pendingPreambleSlot = slot;
    appendProgress(
      () => {
        if (pendingPreambleSlot === slot) {
          pendingPreambleSlot = undefined;
        }
        return slot.payload ?? resolvePreamblePayload();
      },
      "block",
      () => {
        visibleProcessPreviewSeen = true;
      },
    );
    return true;
  };

  const dropPendingProgress = (): void => {
    progressAccepting = false;
    progressCancelled = true;
    pendingReasoningSlot = undefined;
    pendingPreambleSlot = undefined;
  };

  const sealProgress = async (): Promise<void> => {
    if (!isBotWsReply) {
      return;
    }
    if (progressSealPromise) {
      return progressSealPromise;
    }
    progressAccepting = false;
    progressSealPromise = (async () => {
      if (abortSignal?.aborted) {
        dropPendingProgress();
        return;
      }
      if (progressPendingCount === 0) {
        return;
      }
      const drain = progressTail;
      let drainTimeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<boolean>((resolve) => {
        drainTimeout = setTimeout(() => resolve(false), DETACHED_PROGRESS_DRAIN_GRACE_MS);
        drainTimeout.unref?.();
      });
      const drained = await Promise.race([drain.then(() => true), timeoutPromise]);
      if (drainTimeout) {
        clearTimeout(drainTimeout);
      }
      if (!drained) {
        progressCancelled = true;
        pendingReasoningSlot = undefined;
        console.warn(
          `[wecom-b3] progress-drain-timeout sessionKey=${sessionKey} graceMs=${DETACHED_PROGRESS_DRAIN_GRACE_MS}`,
        );
      }
    })();
    return progressSealPromise;
  };

  const closeReply = async (externalFinalDelivered = false): Promise<void> => {
    await sealProgress();
    if (finalDelivered) {
      return;
    }
    const channelData = {
      ...(externalFinalDelivered ? { wecomExternalFinalDelivered: true } : {}),
      // Carries "the answer is still coming" to the transport, which uses it to
      // keep the completion marker off a turn that has not completed.
      ...(deferredTurn ? { wecomDeferredTurn: true } : {}),
    };
    await replyHandle.deliver(
      {
        text: !visibleBodySeen && fastAutoOnText ? fastAutoOnText : "",
        ...(Object.keys(channelData).length > 0 ? { channelData } : {}),
      },
      { kind: "final" },
    );
    finalDelivered = true;
  };

  const failAndThrow = async (error: unknown): Promise<never> => {
    await sealProgress();
    await replyHandle.fail?.(error);
    throw error;
  };

  const deliverHandoffNotice = async (notice: {
    text: string;
    logEvent: "dispatch-absorbed-by-active-run" | "dispatch-busy-not-accepted";
    runSessionId?: string;
    throwForRetry?: boolean;
  }): Promise<void> => {
    console.info(
      `[wecom-b3] ${notice.logEvent} sessionKey=${sessionKey} sessionId=${notice.runSessionId ?? "n/a"}`,
    );
    if (notice.throwForRetry) {
      throw new WeComReplyBusyNotAcceptedError(sessionKey || undefined);
    }
    try {
      await replyHandle.deliver({ text: notice.text }, { kind: "final" });
    } catch (noticeError) {
      await failAndThrow(noticeError);
    }
    finalDelivered = true;
  };

  const botWsReplyOptions: CompatibleReplyOptions | undefined = isBotWsReply
    ? {
        disableBlockStreaming: false,
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        commentaryProgressEnabled: true,
        abortSignal,
        // 6.11 exposes run-start evidence; 7.1 adds turn adoption so a turn
        // steered into an existing run is covered as well.
        onAgentRunStart: () => {
          agentRunStarted = true;
        },
        onTurnAdopted: () => {
          turnAdopted = true;
        },
        onObservedReplyDelivery: () => {
          observedReplyDelivery = true;
        },
        onReasoningStream: (payload) => {
          runActivityObserved = true;
          enqueueReasoning({ text: payload.text ?? "", isReasoning: true });
        },
        onReasoningEnd: () => {
          runActivityObserved = true;
          enqueueProgress(
            { text: "", isReasoning: true, channelData: { reasoningEnd: true } },
            "block",
          );
        },
        // Only real narration reaches the user. Every other lifecycle event
        // has its identifying payload redacted before it could be rendered
        // (禁改 35), so all a tool line can ever say is "🧰 Tool Call:
        // running" — noise that also spends the bubble budget the answer
        // shares. Elapsed-time heartbeats already prove the turn is alive.
        onItemEvent: (payload) => {
          if (payload.kind !== "preamble") {
            return;
          }
          if (enqueuePreamble(payload)) {
            runActivityObserved = true;
          }
        },
        // Nothing is rendered from tool lifecycle, but a started tool is
        // unambiguous proof this turn ran. Without it a tool-only turn that
        // defers its visible reply would be triaged as an empty run and
        // answered with an error notice. Unknown/internal item kinds stay
        // excluded: they are not evidence of user-facing work.
        allowToolLifecycleWhenProgressHidden: true,
        onToolStart: () => {
          runActivityObserved = true;
          // Also tells the transport the turn has moved from narrating to tool
          // work — that is when its bubble stops changing on its own.
          replyHandle.markRunActivity?.();
        },
        onToolResult: (payload) => {
          if (
            progressAccepting &&
            !abortSignal?.aborted &&
            isFastProgress(payload) &&
            updateFastProgressState(payload)
          ) {
            runActivityObserved = true;
            enqueueProgress(payload, "tool");
          }
        },
      }
    : undefined;

  let result: Awaited<ReturnType<DispatchReply>> | undefined;
  try {
    result = await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: session.ctx,
      cfg,
      replyOptions: isBotWsReply
        ? botWsReplyOptions
        : abortSignal
          ? { abortSignal }
          : undefined,
      dispatcherOptions: {
        deliver: async (payload, info) => {
          runActivityObserved = true;
          if (isBotWsReply && isFastProgress(payload)) {
            return;
          }
          const kind = info?.kind === "final" ? "final" : "block";
          if (isBotWsReply && kind === "final") {
            await sealProgress();
            if (abortSignal?.aborted) {
              return;
            }
          }
          const visibleBody = hasVisibleReplyBody(payload, info?.kind);
          if (isBotWsReply && kind === "final" && fastOffPending && !visibleBody) {
            fastOffEmptyFinalSuppressed = true;
            return;
          }
          const deliveryPayload =
            isBotWsReply && kind === "final" && !visibleBody && !visibleBodySeen && fastAutoOnText
              ? { ...payload, text: fastAutoOnText }
              : payload;
          await dispatchReplyPayload({ replyHandle, payload: deliveryPayload, kind });
          if (visibleBody) {
            visibleBodySeen = true;
            fastOffPending = false;
          }
          if (kind === "final") {
            finalDelivered = true;
          }
        },
        onError: async (error, info) => {
          if (!isBotWsReply) {
            await replyHandle.fail?.(error);
            return;
          }
          if (info?.kind === "final") {
            finalDeliveryError ??= error;
          } else if (info?.kind === "tool") {
            toolDeliveryError ??= error;
          } else {
            blockDeliveryError ??= error;
          }
        },
      },
    });
  } catch (error) {
    if (!isBotWsReply) {
      throw error;
    }
    if (abortSignal?.aborted) {
      // OpenClaw may reject after a supersede instead of resolving its empty
      // dispatch result. The old handle is no longer allowed to fail or close.
      dropPendingProgress();
      return;
    }
    if (finalDelivered) {
      dropPendingProgress();
      return;
    }
    if (observedReplyDelivery) {
      await closeReply(true);
      return;
    }
    return failAndThrow(error);
  }

  if (!isBotWsReply) {
    return;
  }
  if (!result) {
    await sealProgress();
    return;
  }
  if (abortSignal?.aborted) {
    // An aborted dispatch can still resolve with counts or delivery errors;
    // none of those belong to the successor's conversation.
    dropPendingProgress();
    return;
  }
  if (finalDelivered) {
    dropPendingProgress();
    return;
  }

  // The callbacks above stay nonblocking for OpenClaw's model stream. Once the
  // core turn returns, stop accepting progress and briefly drain that lane so
  // a synthetic final/failure cannot overtake an already-started snapshot.
  await sealProgress();
  if (abortSignal?.aborted) {
    dropPendingProgress();
    return;
  }

  const observedDelivery = observedReplyDelivery || result.observedReplyDelivery === true;
  const successfulFinal = result.queuedFinal === true || (result.counts?.final ?? 0) > 0;
  if (observedDelivery) {
    await closeReply(true);
    return;
  }
  const sourceDeliverySuppressed =
    result.sendPolicyDenied === true ||
    result.sourceReplyDeliveryMode === "message_tool_only";

  // OpenClaw marks yielded/deferred turns as fallback-eligible; let the
  // activity/active-run triage below decide instead of failing on Fast off.
  if (
    fastOffPending &&
    (!successfulFinal || fastOffEmptyFinalSuppressed) &&
    result.noVisibleReplyFallbackEligible !== true
  ) {
    return failAndThrow(new WeComReplyNoVisibleOutputError(sessionKey || undefined));
  }
  if (finalDeliveryError !== undefined) {
    return failAndThrow(finalDeliveryError);
  }
  if (successfulFinal) {
    await closeReply(true);
    return;
  }
  if ((result.failedCounts?.final ?? 0) > 0) {
    return failAndThrow(new Error("OpenClaw Bot WS final reply delivery failed."));
  }
  if (
    !visibleBodySeen &&
    !fastAutoOnText &&
    (blockDeliveryError !== undefined || (result.failedCounts?.block ?? 0) > 0)
  ) {
    return failAndThrow(
      blockDeliveryError ?? new Error("OpenClaw Bot WS block reply delivery failed."),
    );
  }
  if (
    !visibleBodySeen &&
    !fastAutoOnText &&
    (toolDeliveryError !== undefined || (result.failedCounts?.tool ?? 0) > 0)
  ) {
    return failAndThrow(
      toolDeliveryError ?? new Error("OpenClaw Bot WS tool reply delivery failed."),
    );
  }
  if (
    isBotWsReply &&
    result.noVisibleReplyFallbackEligible === true &&
    (visibleBodySeen || visibleProcessPreviewSeen) &&
    replyHandle.closeDeferred
  ) {
    // Drain the queued narration first, exactly like closeReply does: the
    // stream is finished on the last CONFIRMED preview, so closing ahead of a
    // still-queued progress frame would drop that step and close on a stale
    // bubble.
    await sealProgress();
    if (abortSignal?.aborted) {
      return;
    }
    deferredTurn = true;
    // The handle declines when the turn still holds body text the user has not
    // seen; delivering that is worth more than skipping the notice, so the
    // ordinary close below owns those turns.
    if (await replyHandle.closeDeferred()) {
      console.info(`[wecom-b3] dispatch-deferred-visible-reply sessionKey=${sessionKey}`);
      return;
    }
  }
  if (
    result.noVisibleReplyFallbackEligible === true &&
    !visibleBodySeen &&
    !fastAutoOnText &&
    !sourceDeliverySuppressed
  ) {
    if (abortSignal?.aborted) {
      // A superseded dispatch must not emit synthetic finals: a deferred
      // close would push a stray "（回复完毕）" bubble, and the absorbed-run
      // lookup could bind the successor's own freshly started run.
      return;
    }
    if (runActivityObserved) {
      // The turn ran (reasoning/tool/progress reached this dispatch) but
      // deferred its visible reply — e.g. it yielded to a pending
      // continuation whose answer arrives through a later run. Failing here
      // would replace that answer with an error notice.
      console.info(`[wecom-b3] dispatch-deferred-no-visible-reply sessionKey=${sessionKey}`);
      deferredTurn = true;
      await closeReply();
      return;
    }
    const absorbingRunSessionId = resolveActiveRunSessionId(sessionKey);
    const adoptedIntoExistingRun =
      turnAdopted && !agentRunStarted && result.beforeAgentRunBlocked !== true;
    if (
      adoptedIntoExistingRun ||
      (!agentRunStarted && result.beforeAgentRunBlocked !== true && absorbingRunSessionId)
    ) {
      // 7.1 reports successful steering through onTurnAdopted without starting
      // another agent run. On 6.11 the active lookup remains the compatibility
      // signal. Either fact means the inbound was accepted and must not retry.
      await deliverHandoffNotice({
        text: BOT_WS_ABSORBED_INBOUND_NOTICE_TEXT,
        logEvent: "dispatch-absorbed-by-active-run",
        runSessionId: absorbingRunSessionId,
      });
      return;
    }
    return failAndThrow(new WeComReplyNoVisibleOutputError(sessionKey || undefined));
  }

  const queuedOutputCount =
    (result.counts?.block ?? 0) +
    (result.counts?.final ?? 0) +
    (result.counts?.tool ?? 0);
  if (
    queuedOutputCount === 0 &&
    !runActivityObserved &&
    !visibleBodySeen &&
    !fastAutoOnText &&
    !sourceDeliverySuppressed
  ) {
    if (result.beforeAgentRunBlocked === true) {
      // onTurnAdopted fires before the before_agent_run hooks in 7.1. When the
      // configured silent-reply policy suppresses the fallback flag, this bit
      // is the only remaining proof that the turn was blocked rather than
      // accepted as an intentional silent reply.
      return failAndThrow(new WeComReplyNoVisibleOutputError(sessionKey || undefined));
    }
    if (turnAdopted || agentRunStarted) {
      // OpenClaw omits the fallback flag when the configured silent reply
      // policy allows an accepted turn to finish without visible output.
      // Keep the transport lifecycle balanced without inventing a failure.
      console.info(`[wecom-b3] dispatch-adopted-silent-reply sessionKey=${sessionKey}`);
      await closeReply();
      return;
    }

    // Both reply-operation admission refusal and inbound dedupe return the
    // same flagless zero result. The active-operation registry can be released
    // between that return and this check, so its current value is diagnostic
    // only. Since neither acceptance callback fired, one bounded retry cannot
    // repeat a newly accepted turn; a second zero result becomes the notice.
    await deliverHandoffNotice({
      text: BOT_WS_BUSY_INBOUND_NOTICE_TEXT,
      logEvent: "dispatch-busy-not-accepted",
      runSessionId: resolveActiveRunSessionId(sessionKey),
      throwForRetry: retryFlaglessBusy,
    });
    return;
  }
  await closeReply();
}
