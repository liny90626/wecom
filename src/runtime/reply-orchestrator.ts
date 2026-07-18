import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness";
import { hasVisibleReplyBody } from "../shared/reply-visibility.js";
import type { ReplyHandle, ReplyPayload } from "../types/index.js";
import type { PreparedSession } from "./session-manager.js";

type DispatchReply = PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"];
type ReplyOptions = NonNullable<Parameters<DispatchReply>[0]["replyOptions"]>;

const BOT_WS_ABSORBED_INBOUND_NOTICE_TEXT =
  "⏳ 上一轮任务仍在进行，本条消息已并入当前任务，完成后一并回复；若长时间未收到回复，请重新发送。";

export class WeComReplyNoVisibleOutputError extends Error {
  constructor(sessionKey?: string) {
    super(`WeCom Bot WS reply produced no visible output${sessionKey ? ` for ${sessionKey}` : ""}.`);
    this.name = "WeComReplyNoVisibleOutputError";
  }
}

function resolveAbsorbingRunSessionId(sessionKey: string): string | undefined {
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
}): Promise<void> {
  const { core, cfg, session, replyHandle, abortSignal } = params;
  const isBotWsReply = replyHandle.context.transport === "bot-ws";
  const sessionKey = String(session.ctx.SessionKey ?? session.route?.sessionKey ?? "");
  let visibleBodySeen = false;
  let finalDelivered = false;
  let observedReplyDelivery = false;
  let runActivityObserved = false;
  let fastOffPending = false;
  let fastOffEmptyFinalSuppressed = false;
  let fastAutoOnText = "";
  let blockDeliveryError: unknown;
  let finalDeliveryError: unknown;
  let toolDeliveryError: unknown;

  const deliverFastProgress = async (payload: ReplyPayload): Promise<void> => {
    const text = payload.text?.trim() ?? "";
    if (!text) {
      return;
    }
    const isAutoOn = /\bauto-on\b/i.test(text);
    await replyHandle.deliver(payload, { kind: "block" });
    if (isAutoOn) {
      fastOffPending = false;
      fastOffEmptyFinalSuppressed = false;
      fastAutoOnText = text;
    } else {
      fastOffPending = true;
      fastOffEmptyFinalSuppressed = false;
      fastAutoOnText = "";
    }
  };

  const closeReply = async (externalFinalDelivered = false): Promise<void> => {
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
    await replyHandle.fail?.(error);
    throw error;
  };

  const botWsReplyOptions: ReplyOptions | undefined = isBotWsReply
    ? {
        disableBlockStreaming: false,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        abortSignal,
        onObservedReplyDelivery: () => {
          observedReplyDelivery = true;
        },
        onReasoningStream: async (payload) => {
          runActivityObserved = true;
          await dispatchReplyPayload({
            replyHandle,
            payload: { text: payload.text ?? "", isReasoning: true },
            kind: "block",
          });
        },
        onReasoningEnd: async () => {
          runActivityObserved = true;
          await dispatchReplyPayload({
            replyHandle,
            payload: { text: "", isReasoning: true, channelData: { reasoningEnd: true } },
            kind: "block",
          });
        },
        onToolResult: async (payload) => {
          runActivityObserved = true;
          if (isFastProgress(payload)) {
            await deliverFastProgress(payload);
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
    if (finalDelivered) {
      return;
    }
    if (observedReplyDelivery) {
      await closeReply();
      return;
    }
    return failAndThrow(error);
  }

  if (!isBotWsReply) {
    return;
  }
  if (!result) {
    return;
  }

  const sourceDeliverySuppressed =
    result.sendPolicyDenied === true ||
    result.sourceReplyDeliveryMode === "message_tool_only";
  const observedDelivery = observedReplyDelivery || result.observedReplyDelivery === true;
  const successfulFinal = result.queuedFinal === true || (result.counts?.final ?? 0) > 0;

  if (
    fastOffPending &&
    !observedDelivery &&
    (!successfulFinal || fastOffEmptyFinalSuppressed)
  ) {
    return failAndThrow(new WeComReplyNoVisibleOutputError(sessionKey || undefined));
  }
  if (finalDelivered) {
    return;
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
    !sourceDeliverySuppressed &&
    !observedDelivery
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
    const absorbingRunSessionId = resolveAbsorbingRunSessionId(sessionKey);
    if (absorbingRunSessionId) {
      // Nothing reached this dispatch and the session still has an active
      // run: OpenClaw steered/queued the inbound into that run. Tell the
      // user instead of reporting a delivery failure for a message that is
      // actually being processed.
      console.info(
        `[wecom-b3] dispatch-absorbed-by-active-run sessionKey=${sessionKey} sessionId=${absorbingRunSessionId}`,
      );
      try {
        await replyHandle.deliver(
          { text: BOT_WS_ABSORBED_INBOUND_NOTICE_TEXT },
          { kind: "final" },
        );
      } catch (noticeError) {
        // The notice is the only feedback for an absorbed message; fall back
        // to the fail path so its own delivery fallbacks can still reach the
        // user rather than leaving the placeholder hanging.
        return failAndThrow(noticeError);
      }
      finalDelivered = true;
      return;
    }
    return failAndThrow(new WeComReplyNoVisibleOutputError(sessionKey || undefined));
  }
  await closeReply();
}
