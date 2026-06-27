import { describe, expect, it, vi } from "vitest";
import { dispatchRuntimeReply } from "./reply-orchestrator.js";

describe("dispatchRuntimeReply", () => {
  it("enables block streaming for bot-ws replies", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } });
    const core = {
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    } as any;

    await dispatchRuntimeReply({
      core,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-a" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver: vi.fn(),
      } as any,
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: false,
          reasoningPreviewEnabled: true,
          onReasoningStream: expect.any(Function),
          onReasoningEnd: expect.any(Function),
        }),
      }),
    );
  });

  it("forwards reasoning stream callbacks to bot-ws reply handles", async () => {
    let capturedReplyOptions: any;
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      capturedReplyOptions = params.replyOptions;
      await params.replyOptions.onReasoningStream({ text: "推理过程" });
      await params.replyOptions.onReasoningEnd();
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const core = {
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    } as any;

    await dispatchRuntimeReply({
      core,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-a" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(capturedReplyOptions.reasoningPreviewEnabled).toBe(true);
    expect(deliver).toHaveBeenCalledWith(
      { text: "推理过程", isReasoning: true },
      { kind: "block" },
    );
    expect(deliver).toHaveBeenCalledWith(
      { text: "", isReasoning: true },
      { kind: "block" },
    );
  });

  it("synthesizes a final close for bot-ws when only block replies were queued", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: { block: 1, final: 0, tool: 0 },
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const core = {
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    } as any;

    await dispatchRuntimeReply({
      core,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-a" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ text: "" }, { kind: "final" });
  });
});
