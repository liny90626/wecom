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
  let pendingPreambleSlot: { payload: ReplyPayload } | undefined;
  const anonymousPreambleItem = Symbol("anonymous-preamble");
  const preambleTextByItem = new Map<string | typeof anonymousPreambleItem, string>();
  const preambleItemOrder: Array<string | typeof anonymousPreambleItem> = [];
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
    resolvePayload: () => ReplyPayload,
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
        await dispatchReplyPayload({ replyHandle, payload: resolvePayload(), kind: "block" });
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
    pendingPreambleSlot = undefined;
    appendProgress(() => payload, errorKind);
  };

  const enqueuePreamble = (payload: { itemId?: string; progressText?: string }): void => {
    const text = payload.progressText?.trim() ?? "";
    if (!progressAccepting || abortSignal?.aborted || !text) {
      return;
    }
    const itemId = payload.itemId?.trim() || anonymousPreambleItem;
    if (!preambleTextByItem.has(itemId)) {
      preambleItemOrder.push(itemId);
    }
    const previousText = preambleTextByItem.get(itemId) ?? "";
    if (!previousText || text.startsWith(previousText)) {
      preambleTextByItem.set(itemId, text);
    } else if (!previousText.startsWith(text)) {
      preambleTextByItem.set(itemId, `${previousText}\n${text}`);
    }
    const snapshot = preambleItemOrder
      .map((id) => preambleTextByItem.get(id) ?? "")
      .filter(Boolean)
      .join("\n");
    if (!snapshot || snapshot === lastPreambleSnapshot) {
      return;
    }
    lastPreambleSnapshot = snapshot;
    if (pendingPreambleSlot) {
      pendingPreambleSlot.payload = { text: snapshot };
      return;
    }
    const slot = { payload: { text: snapshot } };
    pendingPreambleSlot = slot;
    appendProgress(
      () => {
        if (pendingPreambleSlot === slot) {
          pendingPreambleSlot = undefined;
        }
        return slot.payload;
      },
      "block",
      () => {
        visibleBodySeen = true;
      },
    );
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
    await replyHandle.deliver(
      {
        text: !visibleBodySeen && fastAutoOnText ? fastAutoOnText : "",
        ...(externalFinalDelivered
          ? { channelData: { wecomExternalFinalDelivered: true } }
          : {}),
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
        onItemEvent: (payload) => {
          if (payload.kind !== "preamble") {
            return;
          }
          runActivityObserved = true;
          enqueuePreamble(payload);
        },
        onToolResult: (payload) => {
          runActivityObserved = true;
          if (
            progressAccepting &&
            !abortSignal?.aborted &&
            isFastProgress(payload) &&
            updateFastProgressState(payload)
          ) {
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
