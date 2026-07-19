import { beforeEach, describe, expect, it, vi } from "vitest";

const agentHarnessState = vi.hoisted(() => ({
  resolveActiveEmbeddedRunSessionId: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => agentHarnessState);

import { dispatchRuntimeReply } from "./reply-orchestrator.js";

describe("dispatchRuntimeReply", () => {
  beforeEach(() => {
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReset();
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
  });

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

    expect(typeof capturedReplyOptions.onReasoningStream).toBe("function");
    expect(deliver).toHaveBeenCalledWith(
      { text: "推理过程", isReasoning: true },
      { kind: "block" },
    );
    expect(deliver).toHaveBeenCalledWith(
      { text: "", isReasoning: true, channelData: { reasoningEnd: true } },
      { kind: "block" },
    );
  });

  it("does not let a blocked reasoning delivery trip the OpenClaw idle watchdog", async () => {
    let releaseReasoning!: () => void;
    const blockedReasoningDelivery = new Promise<void>((resolve) => {
      releaseReasoning = resolve;
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      const reasoning = params.replyOptions.onReasoningStream({ text: "长任务思考中" });
      const watchdog = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("LLM idle timeout (120s): no response from model")), 10);
      });
      await Promise.race([reasoning, watchdog]);
      await params.dispatcherOptions.deliver({ text: "任务正文" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockImplementationOnce(() => blockedReasoningDelivery).mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    try {
      await expect(
        dispatchRuntimeReply({
          core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
          cfg: {} as any,
          session: { ctx: { SessionKey: "session-reasoning-backpressure" } } as any,
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
      expect(deliver).toHaveBeenCalledWith({ text: "任务正文" }, { kind: "final" });
      expect(fail).not.toHaveBeenCalled();
    } finally {
      releaseReasoning();
    }
  });

  it("drains detached progress before closing a deferred Bot WS turn", async () => {
    let releaseReasoning!: () => void;
    const reasoningDelivery = new Promise<void>((resolve) => {
      releaseReasoning = resolve;
    });
    const order: string[] = [];
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      params.replyOptions.onReasoningStream({ text: "仍在思考" });
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        noVisibleReplyFallbackEligible: true,
      };
    });
    const deliver = vi.fn().mockImplementation(async (payload, info) => {
      order.push(`${info.kind}:${payload.isReasoning ? "reasoning" : "final"}`);
      if (payload.isReasoning) await reasoningDelivery;
    });

    const dispatch = dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-progress-final-barrier" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["block:reasoning"]);
    expect(order).not.toContain("final:final");

    releaseReasoning();
    await dispatch;
    expect(order).toEqual(["block:reasoning", "final:final"]);
  });

  it("drains detached progress before publishing a dispatch failure", async () => {
    let releaseReasoning!: () => void;
    const reasoningDelivery = new Promise<void>((resolve) => {
      releaseReasoning = resolve;
    });
    const dispatchError = new Error("model stream failed");
    const order: string[] = [];
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      params.replyOptions.onReasoningStream({ text: "失败前的思考" });
      throw dispatchError;
    });
    const deliver = vi.fn().mockImplementation(async (payload, info) => {
      order.push(`${info.kind}:${payload.isReasoning ? "reasoning" : "final"}`);
      if (payload.isReasoning) await reasoningDelivery;
    });
    const fail = vi.fn().mockImplementation(async () => {
      order.push("fail:error");
    });

    const dispatch = dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-progress-failure-barrier" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
        fail,
      } as any,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["block:reasoning"]);

    releaseReasoning();
    await expect(dispatch).rejects.toBe(dispatchError);
    expect(order).toEqual(["block:reasoning", "fail:error"]);
  });

  it("serializes detached progress and coalesces adjacent reasoning snapshots", async () => {
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fastProgress = {
      text: "Fast: auto-off(62s>=60s)",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    };
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      params.replyOptions.onReasoningStream({ text: "第一版思考" });
      params.replyOptions.onReasoningStream({ text: "第二版思考" });
      params.replyOptions.onReasoningStream({ text: "最新思考" });
      params.replyOptions.onToolResult(fastProgress);
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 1 },
        noVisibleReplyFallbackEligible: true,
      };
    });
    const deliver = vi
      .fn()
      .mockImplementationOnce(async () => firstDelivery)
      .mockResolvedValue(undefined);

    const dispatch = dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-progress-coalescing" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deliver).toHaveBeenCalledTimes(1);
    releaseFirst();
    await dispatch;

    expect(deliver.mock.calls.map((call) => call[0])).toEqual([
      { text: "第一版思考", isReasoning: true },
      { text: "最新思考", isReasoning: true },
      fastProgress,
      { text: "" },
    ]);
  });

  it("drops queued progress after the bounded close barrier expires", async () => {
    vi.useFakeTimers();
    let releaseFirst: () => void = () => undefined;
    try {
      const firstDelivery = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const deliveredTexts: string[] = [];
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
        params.replyOptions.onReasoningStream({ text: "已经开始投递" });
        params.replyOptions.onReasoningStream({ text: "仍在队列中的旧进度" });
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          noVisibleReplyFallbackEligible: true,
        };
      });
      const deliver = vi.fn().mockImplementation(async (payload) => {
        deliveredTexts.push(String(payload.text ?? ""));
        if (payload.isReasoning) await firstDelivery;
      });

      const dispatch = dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-progress-bounded-close" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
        } as any,
      });

      await vi.advanceTimersByTimeAsync(500);
      await dispatch;
      expect(deliveredTexts).toEqual(["已经开始投递", ""]);

      releaseFirst();
      await Promise.resolve();
      await Promise.resolve();
      expect(deliveredTexts).toEqual(["已经开始投递", ""]);
    } finally {
      releaseFirst();
      vi.useRealTimers();
    }
  });

  it("keeps a later final when an asynchronous reasoning delivery rejects", async () => {
    const previewError = new Error("preview ACK failed");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      params.replyOptions.onReasoningStream({ text: "思考预览" });
      await params.dispatcherOptions.deliver({ text: "正文仍然完成" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockRejectedValueOnce(previewError).mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-reasoning-reject" } } as any,
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

    expect(deliver).toHaveBeenCalledWith({ text: "正文仍然完成" }, { kind: "final" });
    expect(fail).not.toHaveBeenCalled();
  });

  it("still reports a reasoning delivery failure when no final exists", async () => {
    const previewError = new Error("preview ACK failed");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      params.replyOptions.onReasoningStream({ text: "只有思考没有正文" });
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        noVisibleReplyFallbackEligible: true,
      };
    });
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-reasoning-reject-no-final" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver: vi.fn().mockRejectedValueOnce(previewError),
          fail,
        } as any,
      }),
    ).rejects.toBe(previewError);
    expect(fail).toHaveBeenCalledWith(previewError);
  });

  it("does not let a blocked Fast progress delivery trip the OpenClaw idle watchdog", async () => {
    let releaseProgress!: () => void;
    const blockedProgressDelivery = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      const progress = params.replyOptions.onToolResult({
        text: "Fast: auto-off(62s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      const watchdog = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("LLM idle timeout (120s): no response from model")), 10);
      });
      await Promise.race([progress, watchdog]);
      await params.dispatcherOptions.deliver({ text: "Fast 后正文" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockImplementationOnce(() => blockedProgressDelivery).mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    try {
      await expect(
        dispatchRuntimeReply({
          core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
          cfg: {} as any,
          session: { ctx: { SessionKey: "session-fast-backpressure" } } as any,
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
      expect(deliver).toHaveBeenCalledWith({ text: "Fast 后正文" }, { kind: "final" });
      expect(fail).not.toHaveBeenCalled();
    } finally {
      releaseProgress();
    }
  });

  it("forwards OpenClaw's exhausted LLM failure final without inventing a WeCom error", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.dispatcherOptions.deliver(
        { text: "LLM request failed." },
        { kind: "final" },
      );
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-llm-failed" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
        fail,
      } as any,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      { text: "LLM request failed." },
      { kind: "final" },
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it("forwards OpenClaw's model idle-timeout final as a visible final", async () => {
    const timeoutText =
      "The model did not produce a response before the model idle timeout. Please try again.";
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onReasoningStream({ text: "长任务分析中" });
      await params.dispatcherOptions.deliver(
        { text: timeoutText, isError: true },
        { kind: "final" },
      );
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-model-idle-timeout" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
        fail,
      } as any,
    });

    expect(fail).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenLastCalledWith(
      { text: timeoutText, isError: true },
      { kind: "final" },
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

  it("closes a reasoning-only bot-ws run without failing when the visible reply is deferred", async () => {
    // OpenClaw resolves {noVisibleReplyFallbackEligible} for turns that ran but
    // deferred their visible reply (e.g. yielded to a pending continuation).
    // Failing here would replace the later answer with an error notice.
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onReasoningStream({ text: "仍在分析" });
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        noVisibleReplyFallbackEligible: true,
      };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

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
          deliver,
          fail,
        } as any,
      }),
    ).resolves.toBeUndefined();

    expect(fail).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenLastCalledWith({ text: "" }, { kind: "final" });
  });

  it("prefers the deferred close over the absorbed notice when both apply", async () => {
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-busy");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onReasoningStream({ text: "分析中" });
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
      session: { ctx: { SessionKey: "session-priority" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(deliver).toHaveBeenLastCalledWith({ text: "" }, { kind: "final" });
    expect(
      deliver.mock.calls.some((call) => String(call[0]?.text ?? "").includes("并入")),
    ).toBe(false);
  });

  it("closes the source stream after OpenClaw routes the final externally", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.dispatcherOptions.deliver({ text: "已输出一半" }, { kind: "block" });
      return {
        queuedFinal: true,
        counts: { block: 1, final: 1, tool: 0 },
      };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-routed-final" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(deliver).toHaveBeenNthCalledWith(1, { text: "已输出一半" }, { kind: "block" });
    expect(deliver).toHaveBeenNthCalledWith(
      2,
      { text: "", channelData: { wecomExternalFinalDelivered: true } },
      { kind: "final" },
    );
  });

  it("stays silent on the flag-empty result of a superseded dispatch", async () => {
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-of-successor");
    const abortController = new AbortController();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onReasoningStream({ text: "被接管前的推理" });
      abortController.abort(new Error("superseded by a newer inbound message"));
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        noVisibleReplyFallbackEligible: true,
      };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-superseded-flag-empty" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
        fail,
      } as any,
      abortSignal: abortController.signal,
    });

    expect(fail).not.toHaveBeenCalled();
    // Only the reasoning block delivery — no synthetic final, no notice.
    expect(deliver.mock.calls.every((call) => call[0]?.isReasoning === true)).toBe(true);
  });

  it("stays silent on a superseded flagless dispatch", async () => {
    const abortController = new AbortController();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async () => {
      abortController.abort(new Error("superseded by a newer inbound message"));
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-superseded-flagless" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
        fail,
      } as any,
      abortSignal: abortController.signal,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("stays silent when a superseded dispatch rejects after observed activity", async () => {
    const abortController = new AbortController();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onObservedReplyDelivery();
      abortController.abort(new Error("superseded by a newer inbound message"));
      throw new Error("Dispatch reply operation aborted");
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-superseded-rejected" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
        fail,
      } as any,
      abortSignal: abortController.signal,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("stays silent when a superseded dispatch returns failure counts", async () => {
    const abortController = new AbortController();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async () => {
      abortController.abort(new Error("superseded by a newer inbound message"));
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        failedCounts: { final: 1 },
      };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-superseded-failed-count" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
        fail,
      } as any,
      abortSignal: abortController.signal,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("falls back to the fail path when the absorbed notice cannot be delivered", async () => {
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-busy");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      noVisibleReplyFallbackEligible: true,
    });
    const deliverError = new Error("notice delivery failed");
    const deliver = vi.fn().mockRejectedValue(deliverError);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-absorbed-notice-fails" } } as any,
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
    ).rejects.toBe(deliverError);

    expect(fail).toHaveBeenCalledWith(deliverError);
  });

  it("notifies that the inbound was absorbed when an active run holds the session", async () => {
    // A busy session steers/queues the new message into the active run and the
    // dispatch resolves with nothing delivered — indistinguishable from an
    // empty turn except that the absorbing run is still registered.
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-busy");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      noVisibleReplyFallbackEligible: true,
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-absorbed" } } as any,
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

    expect(fail).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
    const [payload, info] = deliver.mock.calls[0] ?? [];
    expect(info).toEqual({ kind: "final" });
    expect(String(payload?.text)).toContain("并入");
    expect(agentHarnessState.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(
      "session-absorbed",
    );
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

  it("does not fail a Fast auto-off turn that OpenClaw deferred after activity", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onReasoningStream({ text: "正在执行长任务" });
      await params.replyOptions.onToolResult({
        text: "Fast: auto-off(62s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 1 },
        noVisibleReplyFallbackEligible: true,
      };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-fast-deferred" } } as any,
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

    expect(fail).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenNthCalledWith(
      1,
      { text: "正在执行长任务", isReasoning: true },
      { kind: "block" },
    );
    expect(deliver).toHaveBeenNthCalledWith(
      2,
      {
        text: "Fast: auto-off(62s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      },
      { kind: "block" },
    );
    expect(deliver).toHaveBeenLastCalledWith({ text: "" }, { kind: "final" });
  });

  it("accepts a routed final after Fast auto-off progress", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onToolResult({
        text: "Fast: auto-off(62s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-fast-off-routed-final" } } as any,
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

    expect(fail).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenLastCalledWith(
      { text: "", channelData: { wecomExternalFinalDelivered: true } },
      { kind: "final" },
    );
  });

  it("rejects a counted empty final after Fast auto-off progress", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onToolResult({
        text: "Fast: auto-off(62s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      await params.dispatcherOptions.deliver({ text: "" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-fast-off-empty-final" } } as any,
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
