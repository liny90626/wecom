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
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
          onReasoningStream: expect.any(Function),
          onReasoningEnd: expect.any(Function),
          onToolResult: expect.any(Function),
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
      { text: "", isReasoning: true, channelData: { reasoningEnd: true } },
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

  it("rejects zero-output and tool-only bot-ws runs marked fallback eligible", async () => {
    for (const counts of [
      { block: 0, final: 0, tool: 0 },
      { block: 0, final: 0, tool: 1 },
    ]) {
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
        queuedFinal: false,
        counts,
        noVisibleReplyFallbackEligible: true,
      });
      await expect(
        dispatchRuntimeReply({
          core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
          cfg: {} as any,
          session: { ctx: { SessionKey: "session-empty" } } as any,
          replyHandle: {
            context: {
              transport: "bot-ws",
              accountId: "default",
              raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
            },
            deliver: vi.fn(),
          } as any,
        }),
      ).rejects.toThrow("no visible output");
    }
  });

  it("rejects reasoning-only bot-ws runs without a visible final", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onReasoningStream({ text: "仍在分析" });
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        noVisibleReplyFallbackEligible: true,
      };
    });

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-reasoning-only" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver: vi.fn().mockResolvedValue(undefined),
        } as any,
      }),
    ).rejects.toThrow("no visible output");
  });

  it("keeps Fast progress but rejects auto-off without a later body", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onToolResult({
        text: "Fast: auto-off(62s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-fast-off" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
          fail,
        } as any,
      }),
    ).rejects.toThrow("no visible output");
    expect(deliver).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledOnce();
    expect(fail.mock.calls[0]?.[0]).toMatchObject({ name: "WeComReplyNoVisibleOutputError" });
  });

  it("allows Fast auto-on to end without a body", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onToolResult({
        text: "Fast: auto-off(62s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      await params.replyOptions.onToolResult({
        text: "Fast: auto-on",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        noVisibleReplyFallbackEligible: true,
      };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-fast-on" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(deliver).toHaveBeenLastCalledWith({ text: "Fast: auto-on" }, { kind: "final" });
  });

  it("uses the OpenClaw callback as the single Fast progress delivery path", async () => {
    const fast = {
      text: "Fast: auto-off(62s>=60s)",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    };
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onToolResult(fast);
      await params.dispatcherOptions.deliver(fast, { kind: "tool" });
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 1 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-fast-callback" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
        } as any,
      }),
    ).rejects.toThrow("no visible output");

    expect(deliver).toHaveBeenCalledOnce();
  });

  it("accepts current-run message-tool delivery observed before or after Fast auto-off", async () => {
    const run = async (observedAfterFast: boolean) => {
      const sessionKey = `session-message-tool-${String(observedAfterFast)}`;
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
        if (!observedAfterFast) {
          await params.replyOptions.onObservedReplyDelivery();
        }
        await params.replyOptions.onToolResult({
          text: "Fast: auto-off(62s>=60s)",
          channelData: { openclawProgressKind: "fast-mode-auto" },
        });
        if (observedAfterFast) {
          await params.replyOptions.onObservedReplyDelivery();
        }
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
          observedReplyDelivery: true,
        };
      });
      return dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: sessionKey } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
    };

    await expect(run(false)).resolves.toBeUndefined();
    await expect(run(true)).resolves.toBeUndefined();
  });

  it("does not treat message-tool mode without current-run observed delivery as complete", async () => {
    const sessionKey = "session-message-tool-unobserved";
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onToolResult({
        text: "Fast: auto-off(62s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        sourceReplyDeliveryMode: "message_tool_only",
        observedReplyDelivery: false,
      };
    });
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: sessionKey } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver: vi.fn().mockResolvedValue(undefined),
          fail,
        } as any,
      }),
    ).rejects.toThrow("no visible output");
    expect(fail).toHaveBeenCalledOnce();
  });

  it("accepts message-tool delivery completed while Fast auto-off progress is sent", async () => {
    const sessionKey = "session-message-tool-during-fast-off";
    let releaseProgress!: () => void;
    const progressDelivery = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      params.replyOptions.onObservedReplyDelivery();
      const progress = params.replyOptions.onToolResult({
        text: "Fast: auto-off(62s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      await Promise.resolve();
      releaseProgress();
      await progress;
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        sourceReplyDeliveryMode: "message_tool_only",
        observedReplyDelivery: true,
      };
    });
    const deliver = vi
      .fn()
      .mockReturnValueOnce(progressDelivery)
      .mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: sessionKey } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
        } as any,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not hide a failed final behind queuedFinal", async () => {
    const failure = new Error("final delivery failed");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.dispatcherOptions.onError(failure, { kind: "final" });
      return {
        queuedFinal: true,
        counts: { block: 0, final: 1, tool: 0 },
        failedCounts: { final: 1 },
      };
    });

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-final-failure" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver: vi.fn(),
        } as any,
      }),
    ).rejects.toBe(failure);
  });

  it("keeps a later successful final after an earlier candidate delivery failed", async () => {
    const earlierFailure = new Error("earlier candidate delivery failed");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.dispatcherOptions.onError(earlierFailure, { kind: "final" });
      await params.dispatcherOptions.deliver({ text: "最终候选已成功" }, { kind: "final" });
      return {
        queuedFinal: true,
        counts: { block: 0, final: 1, tool: 0 },
        failedCounts: { final: 1 },
      };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-fallback-success" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
          fail,
        } as any,
      }),
    ).resolves.toBeUndefined();

    expect(deliver).toHaveBeenCalledWith({ text: "最终候选已成功" }, { kind: "final" });
    expect(fail).not.toHaveBeenCalled();
  });

});
