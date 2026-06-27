import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import type { ReplyHandle } from "../types/index.js";
import type { PreparedSession } from "./session-manager.js";

export async function dispatchReplyPayload(params: {
  replyHandle: ReplyHandle;
  payload: {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
    audioAsVoice?: boolean;
    isError?: boolean;
    isReasoning?: boolean;
    channelData?: Record<string, unknown>;
  };
  kind: "block" | "final";
}): Promise<void> {
  await params.replyHandle.deliver(params.payload, { kind: params.kind });
}

export async function dispatchRuntimeReply(params: {
  core: PluginRuntime;
  cfg: OpenClawConfig;
  session: PreparedSession;
  replyHandle: ReplyHandle;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { core, cfg, session, replyHandle, abortSignal } = params;
  const botWsReplyOptions =
    replyHandle.context.transport === "bot-ws"
      ? ({
          // WS bot replies should emit block updates instead of waiting for a final-only flush.
          disableBlockStreaming: false,
          // Newer OpenClaw builds gate reasoning preview behind this flag.
          reasoningPreviewEnabled: true,
          abortSignal,
          onReasoningStream: async (payload: { text?: string }) => {
            await dispatchReplyPayload({
              replyHandle,
              payload: { text: payload?.text ?? "", isReasoning: true },
              kind: "block",
            });
          },
          onReasoningEnd: async () => {
            await dispatchReplyPayload({
              replyHandle,
              payload: { text: "", isReasoning: true },
              kind: "block",
            });
          },
        } as Record<string, unknown>)
      : undefined;
  const result = await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: session.ctx,
    cfg,
    replyOptions:
      replyHandle.context.transport === "bot-ws"
        ? botWsReplyOptions
        : abortSignal
          ? { abortSignal }
          : undefined,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        await dispatchReplyPayload({
          replyHandle,
          payload,
          kind: info?.kind === "final" ? "final" : "block",
        });
      },
      onError: async (error) => {
        await replyHandle.fail?.(error);
      },
    },
  });

  if (
    replyHandle.context.transport === "bot-ws" &&
    result &&
    result.queuedFinal !== true &&
    (result.counts?.block ?? 0) > 0
  ) {
    await dispatchReplyPayload({
      replyHandle,
      payload: { text: "" },
      kind: "final",
    });
  }
}
