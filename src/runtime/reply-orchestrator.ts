import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness";
import {
  buildChannelProgressDraftLineForEntry,
  formatChannelProgressDraftText,
  mergeChannelProgressDraftLine,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-streaming";
import { hasVisibleReplyBody } from "../shared/reply-visibility.js";
import type { ReplyHandle, ReplyPayload } from "../types/index.js";
import type { PreparedSession } from "./session-manager.js";

type DispatchReply = PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"];
type ReplyOptions = NonNullable<Parameters<DispatchReply>[0]["replyOptions"]>;
type StructuredProgressKind = "api" | "command" | "patch" | "search" | "tool";
type StructuredProgressEvent = {
  itemId?: string;
  toolCallId?: string;
  kind?: string;
  name?: string;
  phase?: string;
  status?: string;
  exitCode?: number | null;
};
type CompatibleReplyOptions = ReplyOptions & {
  // Added in 2026.7.1. Older cores ignore the extra runtime option.
  onTurnAdopted?: () => void | Promise<void>;
};

// Progress callbacks are intentionally detached from OpenClaw's model stream,
// but the detached lane still needs ordering at turn close. Keep the barrier
// short so a broken ACK cannot hold the actual reply indefinitely.
const DETACHED_PROGRESS_DRAIN_GRACE_MS = 500;
const STRUCTURED_PROGRESS_MAX_LINES = 4;
const STRUCTURED_PROGRESS_ENTRY = {
  streaming: {
    progress: {
      commandText: "status",
      label: false,
      maxLineChars: 160,
      maxLines: STRUCTURED_PROGRESS_MAX_LINES,
    },
  },
};
const SAFE_PROGRESS_TOOL_NAMES = new Set([
  "approval",
  "compaction",
  "exec",
  "plan",
  "tool_call",
]);

function normalizeStructuredProgressKind(kind?: string): StructuredProgressKind | undefined {
  const normalized = kind?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  switch (normalized) {
    case "api":
      return "api";
    case "command":
    case "commandexecution":
    case "exec":
    case "shell":
      return "command";
    case "filechange":
    case "patch":
      return "patch";
    case "search":
    case "websearch":
      return "search";
    case "dynamictoolcall":
    case "mcptoolcall":
    case "tool":
    case "toolcall":
      return "tool";
    default:
      return undefined;
  }
}

function normalizeStructuredProgressStatus(
  status?: string,
  phase?: string,
  exitCode?: number | null,
): string | undefined {
  if (typeof exitCode === "number" && exitCode !== 0) {
    return "failed";
  }
  const normalizedStatus = status?.trim().toLowerCase().replace(/[^a-z]+/g, "");
  switch (normalizedStatus) {
    case "blocked":
    case "declined":
    case "denied":
      return "blocked";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "completed":
    case "accepted":
    case "approved":
    case "granted":
    case "resolved":
    case "success":
    case "succeeded":
      return "completed";
    case "error":
    case "failed":
      return "failed";
    case "inprogress":
    case "running":
      return "running";
    case "pending":
    case "queued":
      return "pending";
    case "expired":
      return "cancelled";
    case "unavailable":
      return "blocked";
  }

  if (exitCode === 0) {
    return "completed";
  }

  const normalizedPhase = phase?.trim().toLowerCase().replace(/[^a-z]+/g, "");
  if (normalizedPhase === "start" || normalizedPhase === "update") {
    return "running";
  }
  if (normalizedPhase === "end" || normalizedPhase === "result") {
    return "completed";
  }
  if (normalizedPhase === "error") {
    return "failed";
  }
  return undefined;
}

function resolveStructuredProgressToolName(
  kind: StructuredProgressKind,
  name?: string,
): string {
  if (kind === "command") {
    return "exec";
  }
  if (kind === "patch") {
    return "apply_patch";
  }
  if (kind === "search") {
    return "web_search";
  }
  const normalizedName = name?.trim().toLowerCase();
  if (normalizedName && SAFE_PROGRESS_TOOL_NAMES.has(normalizedName)) {
    return normalizedName;
  }
  return kind === "api" ? "api" : "tool_call";
}

function buildSafeStructuredProgressInput(payload: StructuredProgressEvent) {
  const itemKind = normalizeStructuredProgressKind(payload.kind);
  if (!itemKind) {
    return undefined;
  }
  return {
    event: "item" as const,
    // OpenClaw can emit both a generic tool item and a specialized item for
    // one call. A shared id keeps those lifecycle views on one visible line.
    itemId: payload.toolCallId?.trim() || payload.itemId?.trim() || undefined,
    toolCallId: payload.toolCallId,
    itemKind,
    name: resolveStructuredProgressToolName(itemKind, payload.name),
    status: normalizeStructuredProgressStatus(payload.status, payload.phase, payload.exitCode),
  };
}

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
  let pendingPreambleSlot: { payload?: ReplyPayload } | undefined;
  let pendingStructuredProgressSlot: { payload?: ReplyPayload } | undefined;
  const anonymousPreambleItem = Symbol("anonymous-preamble");
  const preambleTextByItem = new Map<string | typeof anonymousPreambleItem, string>();
  const preambleItemOrder: Array<string | typeof anonymousPreambleItem> = [];
  let lastPreambleSnapshot = "";
  let structuredProgressLines: ChannelProgressDraftLine[] = [];
  let lastStructuredProgressSnapshot = "";

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
    freezePendingStructuredProgress();
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
    freezePendingStructuredProgress();
    appendProgress(() => payload, errorKind);
  };

  const resolvePreamblePayload = (): ReplyPayload | undefined => {
    const visibleTexts: string[] = [];
    const seenTexts = new Set<string>();
    for (const itemId of preambleItemOrder) {
      const text = preambleTextByItem.get(itemId) ?? "";
      if (!text || seenTexts.has(text)) {
        continue;
      }
      seenTexts.add(text);
      visibleTexts.push(text);
    }
    const snapshot = visibleTexts.join("\n");
    if (!snapshot || snapshot === lastPreambleSnapshot) {
      return undefined;
    }
    lastPreambleSnapshot = snapshot;
    return {
      text: snapshot,
      channelData: { openclawProgressKind: "preamble" },
    };
  };

  function freezePendingPreamble(): void {
    if (!pendingPreambleSlot) {
      return;
    }
    pendingPreambleSlot.payload ??= resolvePreamblePayload();
    pendingPreambleSlot = undefined;
  }

  const resolveStructuredProgressPayload = (): ReplyPayload | undefined => {
    const snapshot = formatChannelProgressDraftText({
      entry: STRUCTURED_PROGRESS_ENTRY,
      lines: structuredProgressLines,
      seed: sessionKey,
    });
    if (!snapshot || snapshot === lastStructuredProgressSnapshot) {
      return undefined;
    }
    lastStructuredProgressSnapshot = snapshot;
    return {
      text: snapshot,
      channelData: { openclawProgressKind: "structured-item" },
    };
  };

  function freezePendingStructuredProgress(): void {
    if (!pendingStructuredProgressSlot) {
      return;
    }
    pendingStructuredProgressSlot.payload ??= resolveStructuredProgressPayload();
    pendingStructuredProgressSlot = undefined;
  }

  const enqueueStructuredProgress = (payload: StructuredProgressEvent): boolean => {
    if (!progressAccepting || abortSignal?.aborted) {
      return false;
    }
    const input = buildSafeStructuredProgressInput(payload);
    if (!input) {
      return false;
    }
    const line = buildChannelProgressDraftLineForEntry(
      STRUCTURED_PROGRESS_ENTRY,
      input,
      { markdown: false, detailMode: "explain", commandText: "status" },
    );
    if (!line) {
      return false;
    }
    const nextLines = mergeChannelProgressDraftLine(structuredProgressLines, line, {
      maxLines: STRUCTURED_PROGRESS_MAX_LINES,
    });
    if (nextLines === structuredProgressLines) {
      return true;
    }
    structuredProgressLines = nextLines;
    pendingReasoningSlot = undefined;
    freezePendingPreamble();
    if (pendingStructuredProgressSlot) {
      return true;
    }
    const slot: { payload?: ReplyPayload } = {};
    pendingStructuredProgressSlot = slot;
    appendProgress(() => {
      if (pendingStructuredProgressSlot === slot) {
        pendingStructuredProgressSlot = undefined;
      }
      return slot.payload ?? resolveStructuredProgressPayload();
    }, "block");
    return true;
  };

  const observeStructuredProgress = (payload: StructuredProgressEvent): void => {
    if (enqueueStructuredProgress(payload)) {
      runActivityObserved = true;
    }
  };

  const enqueuePreamble = (payload: { itemId?: string; progressText?: string }): boolean => {
    const text = payload.progressText?.trim() ?? "";
    if (!progressAccepting || abortSignal?.aborted || !text) {
      return false;
    }
    const itemId = payload.itemId?.trim() || anonymousPreambleItem;
    if (!preambleTextByItem.has(itemId)) {
      preambleItemOrder.push(itemId);
    }
    // OpenClaw has already accumulated/replaced commentary deltas per item;
    // progressText is the authoritative current snapshot, not another delta.
    if (preambleTextByItem.get(itemId) === text) {
      return true;
    }
    preambleTextByItem.set(itemId, text);
    pendingReasoningSlot = undefined;
    freezePendingStructuredProgress();
    if (pendingPreambleSlot) {
      return true;
    }
    const slot: { payload?: ReplyPayload } = {};
    pendingPreambleSlot = slot;
    appendProgress(() => {
      if (pendingPreambleSlot === slot) {
        pendingPreambleSlot = undefined;
      }
      return slot.payload ?? resolvePreamblePayload();
    }, "block");
    return true;
  };

  const dropPendingProgress = (): void => {
    progressAccepting = false;
    progressCancelled = true;
    pendingReasoningSlot = undefined;
    pendingPreambleSlot = undefined;
    pendingStructuredProgressSlot = undefined;
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
          if (payload.kind === "preamble") {
            if (enqueuePreamble(payload)) {
              runActivityObserved = true;
            }
            return;
          }
          observeStructuredProgress(payload);
        },
        allowToolLifecycleWhenProgressHidden: true,
        onToolStart: (payload) => {
          observeStructuredProgress({ ...payload, kind: "tool" });
        },
        onCommandOutput: (payload) => {
          observeStructuredProgress({ ...payload, kind: "command" });
        },
        onPlanUpdate: (payload) => {
          observeStructuredProgress({
            itemId: "openclaw-plan",
            kind: "tool",
            name: "plan",
            phase: payload.phase,
          });
        },
        onApprovalEvent: (payload) => {
          observeStructuredProgress({
            itemId:
              payload.toolCallId?.trim() ||
              payload.approvalId?.trim() ||
              "openclaw-approval",
            toolCallId: payload.toolCallId,
            kind: "tool",
            name: "approval",
            phase: payload.phase,
            status: payload.status,
          });
        },
        onPatchSummary: (payload) => {
          observeStructuredProgress({
            itemId: payload.itemId,
            toolCallId: payload.toolCallId,
            kind: "patch",
            name: "apply_patch",
            phase: payload.phase,
          });
        },
        onCompactionStart: () => {
          observeStructuredProgress({
            itemId: "openclaw-compaction",
            kind: "tool",
            name: "compaction",
            phase: "start",
          });
        },
        onCompactionEnd: () => {
          observeStructuredProgress({
            itemId: "openclaw-compaction",
            kind: "tool",
            name: "compaction",
            phase: "end",
          });
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
