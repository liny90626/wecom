import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WSClient } from "@wecom/aibot-node-sdk";

const agentHarnessState = vi.hoisted(() => ({
  resolveActiveEmbeddedRunSessionId: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => agentHarnessState);

import { dispatchRuntimeReply } from "./reply-orchestrator.js";
import {
  __resetBotWsReplyTestState,
  createBotWsReplyHandle,
} from "../transport/bot-ws/reply.js";

describe("dispatchRuntimeReply", () => {
  beforeEach(() => {
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReset();
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
  });

  it("enables block streaming for bot-ws replies", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.dispatcherOptions.deliver({ text: "ok" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
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
          suppressDefaultToolProgressMessages: true,
          commentaryProgressEnabled: true,
          onAgentRunStart: expect.any(Function),
          onTurnAdopted: expect.any(Function),
          onReasoningStream: expect.any(Function),
          onReasoningEnd: expect.any(Function),
          onItemEvent: expect.any(Function),
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

  it("forwards OpenClaw preamble progress to bot-ws reply handles", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onItemEvent({
        itemId: "commentary-1",
        kind: "preamble",
        progressText: "正在读取仓库配置",
      });
      await params.dispatcherOptions.deliver({ text: "配置检查完成" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-preamble" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(deliver).toHaveBeenNthCalledWith(
      1,
      {
        text: "正在读取仓库配置",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
    expect(deliver).toHaveBeenNthCalledWith(
      2,
      { text: "配置检查完成" },
      { kind: "final" },
    );
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("forwards structured OpenClaw work-item progress before a long-task failure", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onItemEvent({
        itemId: "tool:long-step-1",
        toolCallId: "long-step-1",
        kind: "tool",
        title: "exec cat /private/credentials",
        name: "internal_customer_secret_api",
        phase: "start",
        status: "running",
        meta: "cat /private/credentials",
        progressText: "SECRET_COMMAND_OUTPUT",
      });
      await params.replyOptions.onItemEvent({
        itemId: "command:long-step-1",
        toolCallId: "long-step-1",
        kind: "command_execution",
        title: "command cat /private/credentials",
        name: "bash",
        phase: "end",
        status: "failed",
        summary: "SECRET_COMMAND_OUTPUT",
        progressText: "SECRET_COMMAND_OUTPUT",
        meta: "cat /private/credentials",
      });
      await params.dispatcherOptions.deliver(
        { text: "LLM request failed.", isError: true },
        { kind: "final" },
      );
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-structured-progress" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(deliver).toHaveBeenNthCalledWith(
      1,
      {
        text: "🧰 Tool Call: running",
        channelData: { openclawProgressKind: "structured-item" },
      },
      { kind: "block" },
    );
    expect(deliver).toHaveBeenNthCalledWith(
      2,
      {
        text: "🛠️ Exec: failed",
        channelData: { openclawProgressKind: "structured-item" },
      },
      { kind: "block" },
    );
    expect(deliver).toHaveBeenNthCalledWith(
      3,
      { text: "LLM request failed.", isError: true },
      { kind: "final" },
    );
    expect(JSON.stringify(deliver.mock.calls)).not.toContain("/private/credentials");
    expect(JSON.stringify(deliver.mock.calls)).not.toContain("SECRET_COMMAND_OUTPUT");
    expect(JSON.stringify(deliver.mock.calls)).not.toContain("internal_customer_secret_api");
  });

  it.each([
    ["accepted", "🧩 Approval"],
    ["approved", "🧩 Approval"],
    ["expired", "Approval: cancelled"],
    ["unavailable", "Approval: blocked"],
  ])("normalizes structured progress status %s", async (status, expectedProgress) => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onItemEvent({
        itemId: `approval-${status}`,
        kind: "tool",
        name: "approval",
        status,
      });
      await params.dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: `session-status-${status}` } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(String(deliver.mock.calls[0]?.[0]?.text ?? "")).toContain(expectedProgress);
    expect(deliver).toHaveBeenLastCalledWith({ text: "done" }, { kind: "final" });
  });

  it("receives sanitized work-item progress through the real OpenClaw dispatcher", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousTestFast = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_STATE_DIR = "/tmp/wecom-openclaw-progress-dispatcher-test";
    process.env.OPENCLAW_TEST_FAST = "1";
    try {
      const { dispatchReplyWithBufferedBlockDispatcher: realDispatch } = await import(
        "openclaw/plugin-sdk/reply-runtime"
      );
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation((params) =>
        realDispatch({
          ...params,
          replyResolver: async (_ctx, options) => {
            await options.onItemEvent?.({
              itemId: "command:real-1",
              toolCallId: "real-1",
              kind: "command",
              title: "command cat /private/runtime-secret",
              name: "exec",
              phase: "start",
              status: "running",
              meta: "cat /private/runtime-secret",
              progressText: "REAL_SECRET_OUTPUT",
            });
            return { text: "真实 dispatcher 最终答案" };
          },
        }),
      );
      const deliver = vi.fn().mockResolvedValue(undefined);

      await dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: {
          ctx: {
            Body: "执行长任务",
            RawBody: "执行长任务",
            CommandBody: "执行长任务",
            From: "user-real-dispatcher",
            To: "wecom-bot",
            SessionKey: "agent:main:wecom:direct:user-real-dispatcher",
            Provider: "wecom",
            Surface: "wecom",
            ChatType: "direct",
            AccountId: "default",
            MessageSid: "msg-real-dispatcher",
          },
        } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
        } as any,
      });

      expect(deliver.mock.calls).toEqual([
        [
          {
            text: "🛠️ Exec: running",
            channelData: { openclawProgressKind: "structured-item" },
          },
          { kind: "block" },
        ],
        [{ text: "真实 dispatcher 最终答案" }, { kind: "final" }],
      ]);
      expect(JSON.stringify(deliver.mock.calls)).not.toContain("/private/runtime-secret");
      expect(JSON.stringify(deliver.mock.calls)).not.toContain("REAL_SECRET_OUTPUT");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousTestFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousTestFast;
      }
    }
  });

  it("receives sanitized tool lifecycle progress when OpenClaw emits no item event", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousTestFast = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_STATE_DIR = "/tmp/wecom-openclaw-tool-lifecycle-dispatcher-test";
    process.env.OPENCLAW_TEST_FAST = "1";
    try {
      const { dispatchReplyWithBufferedBlockDispatcher: realDispatch } = await import(
        "openclaw/plugin-sdk/reply-runtime"
      );
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation((params) =>
        realDispatch({
          ...params,
          replyResolver: async (_ctx, options) => {
            await options.onToolStart?.({
              itemId: "tool:lifecycle-1",
              toolCallId: "lifecycle-1",
              name: "exec",
              phase: "start",
              args: { command: "cat /private/tool-start-secret" },
              detailMode: "raw",
            });
            await options.onCommandOutput?.({
              itemId: "command:lifecycle-1",
              toolCallId: "lifecycle-1",
              name: "exec",
              phase: "end",
              status: "failed",
              exitCode: 1,
              output: "TOOL_LIFECYCLE_SECRET_OUTPUT",
              cwd: "/private/tool-lifecycle-cwd",
            });
            return { text: "工具生命周期 dispatcher 最终答案" };
          },
        }),
      );
      const deliver = vi.fn().mockResolvedValue(undefined);

      await dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: {
          ctx: {
            Body: "执行只有 tool lifecycle 的长任务",
            RawBody: "执行只有 tool lifecycle 的长任务",
            CommandBody: "执行只有 tool lifecycle 的长任务",
            From: "user-tool-lifecycle",
            To: "wecom-bot",
            SessionKey: "agent:main:wecom:direct:user-tool-lifecycle",
            Provider: "wecom",
            Surface: "wecom",
            ChatType: "direct",
            AccountId: "default",
            MessageSid: "msg-tool-lifecycle",
          },
        } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
        } as any,
      });

      expect(deliver.mock.calls).toEqual([
        [
          {
            text: "🛠️ Exec: running",
            channelData: { openclawProgressKind: "structured-item" },
          },
          { kind: "block" },
        ],
        [
          {
            text: "🛠️ Exec: failed",
            channelData: { openclawProgressKind: "structured-item" },
          },
          { kind: "block" },
        ],
        [{ text: "工具生命周期 dispatcher 最终答案" }, { kind: "final" }],
      ]);
      expect(JSON.stringify(deliver.mock.calls)).not.toContain("/private/tool-start-secret");
      expect(JSON.stringify(deliver.mock.calls)).not.toContain("TOOL_LIFECYCLE_SECRET_OUTPUT");
      expect(JSON.stringify(deliver.mock.calls)).not.toContain("/private/tool-lifecycle-cwd");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousTestFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousTestFast;
      }
    }
  });

  it("receives sanitized plan, approval, patch, and compaction lifecycle progress", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousTestFast = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_STATE_DIR = "/tmp/wecom-openclaw-extended-lifecycle-test";
    process.env.OPENCLAW_TEST_FAST = "1";
    try {
      const { dispatchReplyWithBufferedBlockDispatcher: realDispatch } = await import(
        "openclaw/plugin-sdk/reply-runtime"
      );
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation((params) =>
        realDispatch({
          ...params,
          replyResolver: async (_ctx, options) => {
            await options.onPlanUpdate?.({
              phase: "start",
              title: "SECRET_PLAN_TITLE",
              explanation: "SECRET_PLAN_EXPLANATION",
              steps: ["inspect /private/plan-secret"],
              source: "SECRET_PLAN_SOURCE",
            });
            await options.onApprovalEvent?.({
              phase: "requested",
              kind: "command",
              status: "pending",
              title: "SECRET_APPROVAL_TITLE",
              approvalId: "approval-private-1",
              command: "cat /private/approval-secret",
              host: "private-host",
              reason: "SECRET_APPROVAL_REASON",
              message: "SECRET_APPROVAL_MESSAGE",
            });
            await options.onPatchSummary?.({
              itemId: "patch:extended-1",
              toolCallId: "extended-1",
              phase: "end",
              title: "SECRET_PATCH_TITLE",
              name: "apply_patch",
              added: ["/private/added-secret"],
              modified: ["/private/modified-secret"],
              summary: "SECRET_PATCH_SUMMARY",
            });
            await options.onCompactionStart?.();
            await options.onCompactionEnd?.();
            return { text: "扩展生命周期 dispatcher 最终答案" };
          },
        }),
      );
      const deliver = vi.fn().mockResolvedValue(undefined);

      await dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: {
          ctx: {
            Body: "执行包含多类生命周期事件的长任务",
            RawBody: "执行包含多类生命周期事件的长任务",
            CommandBody: "执行包含多类生命周期事件的长任务",
            From: "user-extended-lifecycle",
            To: "wecom-bot",
            SessionKey: "agent:main:wecom:direct:user-extended-lifecycle",
            Provider: "wecom",
            Surface: "wecom",
            ChatType: "direct",
            AccountId: "default",
            MessageSid: "msg-extended-lifecycle",
          },
        } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
        } as any,
      });

      const progressText = deliver.mock.calls
        .filter((call) => call[1]?.kind === "block")
        .map((call) => String(call[0]?.text ?? ""))
        .join("\n");
      expect(progressText).toContain("Plan: running");
      expect(progressText).toContain("Approval: pending");
      expect(progressText).toContain("Apply Patch");
      expect(progressText).toContain("Compaction");
      expect(deliver).toHaveBeenLastCalledWith(
        { text: "扩展生命周期 dispatcher 最终答案" },
        { kind: "final" },
      );
      expect(JSON.stringify(deliver.mock.calls)).not.toContain("SECRET_");
      expect(JSON.stringify(deliver.mock.calls)).not.toContain("/private/");
      expect(JSON.stringify(deliver.mock.calls)).not.toContain("private-host");
      expect(JSON.stringify(deliver.mock.calls)).not.toContain("approval-private-1");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousTestFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousTestFast;
      }
    }
  });

  it.each([
    [
      "future-internal",
      {
        kind: "future_internal",
        phase: "start",
        status: "running",
        title: "SECRET_FUTURE_TITLE",
        output: "SECRET_FUTURE_OUTPUT",
      },
    ],
    ["analysis", { kind: "analysis", phase: "start", status: "running" }],
    ["status", { kind: "status", phase: "update", status: "running" }],
    ["empty-preamble", { kind: "preamble", progressText: "   " }],
  ])(
    "keeps fallback-eligible zero output failing after filtered %s item events",
    async (caseId, itemEvent) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const previousTestFast = process.env.OPENCLAW_TEST_FAST;
      process.env.OPENCLAW_STATE_DIR = `/tmp/wecom-openclaw-filtered-item-${caseId}`;
      process.env.OPENCLAW_TEST_FAST = "1";
      try {
        const { dispatchReplyWithBufferedBlockDispatcher: realDispatch } = await import(
          "openclaw/plugin-sdk/reply-runtime"
        );
        const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation((params) =>
          realDispatch({
            ...params,
            replyResolver: async (_ctx, options) => {
              await options.onAgentRunStart?.(`run-filtered-${caseId}`);
              await options.onItemEvent?.(itemEvent);
              return undefined;
            },
          }),
        );
        const deliver = vi.fn().mockResolvedValue(undefined);
        const fail = vi.fn().mockResolvedValue(undefined);

        await expect(
          dispatchRuntimeReply({
            core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
            cfg: {} as any,
            session: {
              ctx: {
                Body: `执行过滤事件回归 ${caseId}`,
                RawBody: `执行过滤事件回归 ${caseId}`,
                CommandBody: `执行过滤事件回归 ${caseId}`,
                From: `user-filtered-${caseId}`,
                To: "wecom-bot",
                SessionKey: `agent:main:wecom:direct:user-filtered-${caseId}`,
                Provider: "wecom",
                Surface: "wecom",
                ChatType: "direct",
                AccountId: "default",
                MessageSid: `msg-filtered-${caseId}`,
              },
            } as any,
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
        ).rejects.toMatchObject({ name: "WeComReplyNoVisibleOutputError" });

        expect(deliver).not.toHaveBeenCalled();
        expect(fail).toHaveBeenCalledOnce();
        expect(fail.mock.calls[0]?.[0]).toMatchObject({
          name: "WeComReplyNoVisibleOutputError",
        });
        expect(JSON.stringify(deliver.mock.calls)).not.toContain("SECRET_FUTURE");
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
        if (previousTestFast === undefined) {
          delete process.env.OPENCLAW_TEST_FAST;
        } else {
          process.env.OPENCLAW_TEST_FAST = previousTestFast;
        }
      }
    },
  );

  it("keeps fallback-eligible zero output failing after a filtered ordinary tool result", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onAgentRunStart?.("run-filtered-tool-result");
      await params.replyOptions.onToolResult({
        text: "SECRET_FILTERED_TOOL_RESULT",
        channelData: { internalOnly: true },
      });
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
        session: { ctx: { SessionKey: "session-filtered-tool-result" } } as any,
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
    ).rejects.toMatchObject({ name: "WeComReplyNoVisibleOutputError" });

    expect(deliver).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledOnce();
    expect(JSON.stringify(deliver.mock.calls)).not.toContain("SECRET_FILTERED_TOOL_RESULT");
  });

  it("preserves preamble order when OpenClaw omits an item id", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onItemEvent({
        kind: "preamble",
        progressText: "正在准备上下文",
      });
      await params.replyOptions.onItemEvent({
        itemId: "commentary-2",
        kind: "preamble",
        progressText: "正在读取仓库",
      });
      await params.dispatcherOptions.deliver({ text: "读取完成" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-preamble-anonymous" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(deliver).toHaveBeenNthCalledWith(
      2,
      {
        text: "正在准备上下文\n正在读取仓库",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
  });

  it("coalesces cumulative preamble snapshots without letting final overtake them", async () => {
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      params.replyOptions.onItemEvent({
        itemId: "commentary-1",
        kind: "preamble",
        progressText: "正在读取",
      });
      params.replyOptions.onItemEvent({
        itemId: "commentary-1",
        kind: "preamble",
        progressText: "正在读取仓库配置",
      });
      params.replyOptions.onItemEvent({
        itemId: "commentary-2",
        kind: "preamble",
        progressText: "正在验证依赖",
      });
      releaseFirst();
      await params.dispatcherOptions.deliver({ text: "验证完成" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi
      .fn()
      .mockImplementationOnce(() => firstDelivery)
      .mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-preamble-coalescing" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(deliver.mock.calls).toEqual([
      [
        { text: "正在读取", channelData: { openclawProgressKind: "preamble" } },
        { kind: "block" },
      ],
      [
        {
          text: "正在读取仓库配置\n正在验证依赖",
          channelData: { openclawProgressKind: "preamble" },
        },
        { kind: "block" },
      ],
      [{ text: "验证完成" }, { kind: "final" }],
    ]);
  });

  it("deduplicates identical preamble text across items while preserving later updates", async () => {
    const run = async (
      sessionKey: string,
      events: Array<{ itemId: string; progressText: string }>,
    ) => {
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
        for (const event of events) {
          await params.replyOptions.onItemEvent({ kind: "preamble", ...event });
        }
        await params.dispatcherOptions.deliver({ text: "任务已终止" }, { kind: "final" });
        return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
      });
      const deliver = vi.fn().mockResolvedValue(undefined);

      await dispatchRuntimeReply({
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
      });

      return deliver.mock.calls;
    };

    await expect(
      run("session-preamble-cross-item-dedup", [
        { itemId: "commentary-1", progressText: "正在评估终止风险" },
        { itemId: "commentary-2", progressText: "正在评估终止风险" },
      ]),
    ).resolves.toEqual([
      [
        { text: "正在评估终止风险", channelData: { openclawProgressKind: "preamble" } },
        { kind: "block" },
      ],
      [{ text: "任务已终止" }, { kind: "final" }],
    ]);

    await expect(
      run("session-preamble-cross-item-update", [
        { itemId: "commentary-1", progressText: "正在评估终止风险" },
        { itemId: "commentary-2", progressText: "正在评估终止风险" },
        { itemId: "commentary-2", progressText: "终止风险评估完成" },
      ]),
    ).resolves.toEqual([
      [
        { text: "正在评估终止风险", channelData: { openclawProgressKind: "preamble" } },
        { kind: "block" },
      ],
      [
        {
          text: "正在评估终止风险\n终止风险评估完成",
          channelData: { openclawProgressKind: "preamble" },
        },
        { kind: "block" },
      ],
      [{ text: "任务已终止" }, { kind: "final" }],
    ]);
  });

  it.each([
    ["keyed", "commentary-replaced"],
    ["anonymous", undefined],
  ])("treats each %s OpenClaw preamble value as the current item snapshot", async (_label, itemId) => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onItemEvent({
        itemId,
        kind: "preamble",
        progressText: "正在检查仓库中的全部配置文件",
      });
      await params.replyOptions.onItemEvent({
        itemId,
        kind: "preamble",
        progressText: "配置检查完成",
      });
      await params.dispatcherOptions.deliver({ text: "最终答案" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-preamble-replaced" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(deliver).toHaveBeenNthCalledWith(
      2,
      {
        text: "配置检查完成",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
  });

  it("coalesces ten thousand preamble items without rebuilding every pending snapshot", async () => {
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let burstElapsedMs = Number.POSITIVE_INFINITY;
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      params.replyOptions.onItemEvent({
        itemId: "item-0",
        kind: "preamble",
        progressText: "步骤0",
      });
      const startedAt = performance.now();
      for (let index = 1; index < 10_000; index += 1) {
        params.replyOptions.onItemEvent({
          itemId: `item-${index}`,
          kind: "preamble",
          progressText: `步骤${index}`,
        });
      }
      burstElapsedMs = performance.now() - startedAt;
      releaseFirst();
      await params.dispatcherOptions.deliver({ text: "批量检查完成" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi
      .fn()
      .mockImplementationOnce(() => firstDelivery)
      .mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-preamble-burst" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
    });

    expect(burstElapsedMs).toBeLessThan(1_000);
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(String(deliver.mock.calls[1]?.[0]?.text)).toContain("步骤9999");
    expect(deliver.mock.calls[2]).toEqual([
      { text: "批量检查完成" },
      { kind: "final" },
    ]);
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

  it("delivers the final through a real Bot WS handle while the reasoning ACK is pending", async () => {
    __resetBotWsReplyTestState();
    let pendingAck = false;
    let releaseReasoningAck!: () => void;
    const client = {
      replyStreamNonBlocking: vi.fn(() => {
        pendingAck = true;
        return new Promise((resolve) => {
          releaseReasoningAck = () => resolve({});
        });
      }),
      hasPendingReplyAck: vi.fn(() => pendingAck),
      replyStream: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockResolvedValue({}),
      replyWelcome: vi.fn().mockResolvedValue({}),
    } as unknown as WSClient;
    const replyHandle = createBotWsReplyHandle({
      client,
      frame: {
        headers: { req_id: "req-real-handle-pending-reasoning" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as any,
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      let callbackTimedOut = false;
      const reasoningCallback = params.replyOptions.onReasoningStream({ text: "长任务思考中" });
      await Promise.race([
        Promise.resolve(reasoningCallback),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            callbackTimedOut = true;
            resolve();
          }, 5);
        }),
      ]);
      expect(callbackTimedOut).toBe(false);

      setTimeout(() => {
        pendingAck = false;
        releaseReasoningAck();
      }, 20);
      await params.dispatcherOptions.deliver({ text: "任务最终正文" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-real-handle-pending-reasoning" } } as any,
        replyHandle,
      }),
    ).resolves.toBeUndefined();

    expect((client as any).replyStreamNonBlocking).toHaveBeenCalledTimes(1);
    expect((client as any).replyStream).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { req_id: "req-real-handle-pending-reasoning" },
      }),
      expect.any(String),
      "任务最终正文",
      true,
    );
    expect((client as any).sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to active push when a real Bot WS reasoning ACK stays blocked", async () => {
    vi.useFakeTimers();
    __resetBotWsReplyTestState();
    let pendingAck = false;
    let releaseReasoningAck: () => void = () => undefined;
    try {
      const client = {
        replyStreamNonBlocking: vi.fn(() => {
          pendingAck = true;
          return new Promise((resolve) => {
            releaseReasoningAck = () => resolve({});
          });
        }),
        hasPendingReplyAck: vi.fn(() => pendingAck),
        replyStream: vi.fn().mockResolvedValue({}),
        sendMessage: vi.fn().mockResolvedValue({}),
        replyWelcome: vi.fn().mockResolvedValue({}),
      } as unknown as WSClient;
      const replyHandle = createBotWsReplyHandle({
        client,
        frame: {
          headers: { req_id: "req-real-handle-stuck-reasoning" },
          body: { from: { userid: "alice" }, chattype: "single" },
        } as any,
        accountId: "default",
        inboundKind: "text",
        autoSendPlaceholder: false,
      });
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
        params.replyOptions.onReasoningStream({ text: "长任务思考中" });
        await params.dispatcherOptions.deliver({ text: "不能丢失的最终正文" }, { kind: "final" });
        return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
      });

      const dispatch = dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-real-handle-stuck-reasoning" } } as any,
        replyHandle,
      });
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(5_500);
      await dispatch;

      expect((client as any).replyStream).not.toHaveBeenCalled();
      expect((client as any).sendMessage).toHaveBeenCalledWith(
        "alice",
        expect.objectContaining({
          msgtype: "markdown",
          markdown: expect.objectContaining({
            content: expect.stringContaining("不能丢失的最终正文"),
          }),
        }),
      );
    } finally {
      pendingAck = false;
      releaseReasoningAck();
      await Promise.resolve();
      vi.clearAllTimers();
      vi.useRealTimers();
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

  it("drains detached progress before delivering an ordinary final", async () => {
    let releaseReasoning!: () => void;
    const reasoningDelivery = new Promise<void>((resolve) => {
      releaseReasoning = resolve;
    });
    const order: string[] = [];
    let finalStartedBeforeReasoningReleased = false;
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      params.replyOptions.onReasoningStream({ text: "最终正文前的思考" });
      const finalDelivery = params.dispatcherOptions.deliver(
        { text: "任务最终正文" },
        { kind: "final" },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      finalStartedBeforeReasoningReleased = order.includes("final:final");
      releaseReasoning();
      await finalDelivery;
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const deliver = vi.fn().mockImplementation(async (payload, info) => {
      order.push(`${info.kind}:${payload.isReasoning ? "reasoning" : "final"}`);
      if (payload.isReasoning) await reasoningDelivery;
    });

    try {
      await dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-progress-ordinary-final-barrier" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
        } as any,
      });
      expect(finalStartedBeforeReasoningReleased).toBe(false);
      expect(order).toEqual(["block:reasoning", "final:final"]);
    } finally {
      releaseReasoning();
    }
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
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
        await params.replyOptions.onTurnAdopted();
        await params.replyOptions.onAgentRunStart("run-empty");
        return {
          queuedFinal: false,
          counts,
          noVisibleReplyFallbackEligible: true,
        };
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

  it("does not retry a fallback-eligible busy result after OpenClaw may have run", async () => {
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-deferred");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      noVisibleReplyFallbackEligible: true,
    });
    const deliver = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-deferred-busy" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
        } as any,
        retryFlaglessBusy: true,
      }),
    ).resolves.toBeUndefined();

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(
      { text: expect.stringContaining("已并入当前任务") },
      { kind: "final" },
    );
  });

  it("keeps an adopted steer accepted after its active run releases before triage", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onTurnAdopted();
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
        session: { ctx: { SessionKey: "session-adopted-steer-released" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
          fail,
        } as any,
        retryFlaglessBusy: true,
      }),
    ).resolves.toBeUndefined();

    expect(agentHarnessState.resolveActiveEmbeddedRunSessionId).toHaveReturnedWith(undefined);
    expect(deliver).toHaveBeenCalledWith(
      { text: expect.stringContaining("已并入当前任务") },
      { kind: "final" },
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it("still fails a turn blocked before the agent run despite adoption bookkeeping", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onTurnAdopted();
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        noVisibleReplyFallbackEligible: true,
        beforeAgentRunBlocked: true,
      };
    });
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-before-agent-blocked" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver: vi.fn(),
          fail,
        } as any,
      }),
    ).rejects.toThrow("no visible output");

    expect(fail).toHaveBeenCalledOnce();
  });

  it("still fails a flagless blocked turn when silent-reply policy hides the fallback flag", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onTurnAdopted();
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        beforeAgentRunBlocked: true,
      };
    });
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-flagless-before-agent-blocked" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver: vi.fn(),
          fail,
        } as any,
        retryFlaglessBusy: true,
      }),
    ).rejects.toThrow("no visible output");

    expect(fail).toHaveBeenCalledOnce();
  });

  it("tells the user an absorbed inbound is being handled by the running task", async () => {
    // OpenClaw steers/enqueues an inbound into the still-active run and resolves
    // the dispatch with nothing delivered but the fallback flag set. The message
    // was accepted, so asking the user to resend it duplicates model work.
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-absorbing");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      noVisibleReplyFallbackEligible: true,
    });
    const deliver = vi.fn().mockResolvedValue(undefined);

    await dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-absorbed-wording" } } as any,
      replyHandle: {
        context: {
          transport: "bot-ws",
          accountId: "default",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver,
      } as any,
      retryFlaglessBusy: true,
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(
      { text: expect.stringContaining("已并入当前任务") },
      { kind: "final" },
    );
    expect(String(deliver.mock.calls[0]?.[0]?.text ?? "")).not.toContain("确认新指令未执行");
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

  it("does not retry two externally delivered replies after their source streams expire", async () => {
    vi.useFakeTimers();
    __resetBotWsReplyTestState();
    const expiredError = {
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    const pushed: string[] = [];
    let expireFinalStream = true;
    const client = {
      replyStream: vi.fn(async (_frame, _streamId, _content, finish) => {
        if (finish && expireFinalStream) {
          throw expiredError;
        }
        return {};
      }),
      sendMessage: vi.fn(async (_peerId, message) => {
        const content = String(message?.markdown?.content ?? "");
        pushed.push(content);
        if (content.includes("本次回复投递中断")) {
          return {};
        }
        throw new Error("source stream fallback unavailable");
      }),
      replyWelcome: vi.fn().mockResolvedValue({}),
    } as unknown as WSClient;

    const runExternallyDeliveredTurn = async (turn: number) => {
      const replyHandle = createBotWsReplyHandle({
        client,
        frame: {
          headers: { req_id: `req-observed-expired-${turn}` },
          body: { from: { userid: "alice" }, chattype: "single" },
        } as any,
        accountId: "default",
        inboundKind: "text",
        autoSendPlaceholder: false,
      });
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
        await params.dispatcherOptions.deliver(
          { text: `第${turn}轮已显示的进度` },
          { kind: "block" },
        );
        replyHandle.markExternalActivity?.();
        await params.replyOptions.onObservedReplyDelivery();
        return {
          queuedFinal: false,
          counts: { block: 1, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
          observedReplyDelivery: true,
        };
      });

      await dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: `session-observed-expired-${turn}` } } as any,
        replyHandle,
      });

      for (const delayMs of [20_000, 40_000, 80_000]) {
        await vi.advanceTimersByTimeAsync(delayMs);
        await Promise.resolve();
      }
    };

    try {
      await runExternallyDeliveredTurn(1);
      await runExternallyDeliveredTurn(2);

      expect(pushed.filter((text) => text.includes("本次回复投递中断"))).toHaveLength(0);

      expireFinalStream = false;
      const thirdReplyHandle = createBotWsReplyHandle({
        client,
        frame: {
          headers: { req_id: "req-observed-expired-3" },
          body: { from: { userid: "alice" }, chattype: "single" },
        } as any,
        accountId: "default",
        inboundKind: "text",
        autoSendPlaceholder: false,
      });
      const thirdDispatch = vi.fn().mockImplementation(async (params) => {
        await params.dispatcherOptions.deliver({ text: "第三轮正常回复" }, { kind: "final" });
        return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
      });
      await dispatchRuntimeReply({
        core: {
          channel: { reply: { dispatchReplyWithBufferedBlockDispatcher: thirdDispatch } },
        } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-observed-expired-3" } } as any,
        replyHandle: thirdReplyHandle,
      });

      expect(
        (client as any).replyStream.mock.calls.some(
          (call: unknown[]) => call[2] === "第三轮正常回复" && call[3] === true,
        ),
      ).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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

  it("falls back to the fail path when the busy notice cannot be delivered", async () => {
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-busy");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
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

  it("does not opt into OpenClaw steering after the previous handle was superseded", async () => {
    agentHarnessState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-busy");
    let replyOptions: any;
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      replyOptions = params.replyOptions;
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
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
    expect(replyOptions.queuedFollowupLifecycle).toBeUndefined();
    expect(String(payload?.text)).toContain("确认新指令未执行后再重试");
  });

  it("retries an unadopted flagless empty result after the active run has released", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-empty-without-active-run" } } as any,
        replyHandle: {
          context: {
            transport: "bot-ws",
            accountId: "default",
            raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
          },
          deliver,
          fail,
        } as any,
        retryFlaglessBusy: true,
      }),
    ).rejects.toMatchObject({ name: "WeComReplyBusyNotAcceptedError" });

    expect(deliver).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("reports an unadopted flagless empty result after the bounded retry", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-empty-after-retry" } } as any,
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

    expect(deliver).toHaveBeenCalledWith(
      { text: expect.stringContaining("确认新指令未执行后再重试") },
      { kind: "final" },
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it.each(["onAgentRunStart", "onTurnAdopted"] as const)(
    "settles a flagless empty turn accepted through %s without reporting a failure",
    async (adoptionCallback) => {
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
        await params.replyOptions[adoptionCallback]("run-adopted-silent");
        return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
      });
      const deliver = vi.fn().mockResolvedValue(undefined);
      const fail = vi.fn().mockResolvedValue(undefined);

      await expect(
        dispatchRuntimeReply({
          core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
          cfg: {} as any,
          session: { ctx: { SessionKey: "session-adopted-silent" } } as any,
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

      expect(deliver).toHaveBeenCalledWith({ text: "" }, { kind: "final" });
      expect(fail).not.toHaveBeenCalled();
    },
  );

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
      const deliver = vi.fn().mockResolvedValue(undefined);
      await dispatchRuntimeReply({
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
      });
      return deliver;
    };

    for (const observedAfterFast of [false, true]) {
      const deliver = await run(observedAfterFast);
      expect(deliver).toHaveBeenLastCalledWith(
        { text: "", channelData: { wecomExternalFinalDelivered: true } },
        { kind: "final" },
      );
    }
  });

  it("settles an observed external reply when OpenClaw rejects after delivery", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.replyOptions.onObservedReplyDelivery();
      throw new Error("model failed after committed message-tool delivery");
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchRuntimeReply({
        core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
        cfg: {} as any,
        session: { ctx: { SessionKey: "session-observed-then-rejected" } } as any,
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

    expect(deliver).toHaveBeenLastCalledWith(
      { text: "", channelData: { wecomExternalFinalDelivered: true } },
      { kind: "final" },
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it.each([
    ["final callback", { callbackKind: "final" }],
    ["block callback", { callbackKind: "block" }],
    ["tool callback", { callbackKind: "tool" }],
    ["final count", { failedCounts: { final: 1 } }],
    ["block count", { failedCounts: { block: 1 } }],
    ["tool count", { failedCounts: { tool: 1 } }],
  ] as const)(
    "ignores an old-stream %s after observed external delivery",
    async (_label, failure) => {
      const oldStreamError = new Error("old source stream delivery failed");
      const failedCounts = "failedCounts" in failure ? failure.failedCounts : undefined;
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
        if ("callbackKind" in failure) {
          await params.dispatcherOptions.onError(oldStreamError, { kind: failure.callbackKind });
        }
        await params.replyOptions.onObservedReplyDelivery();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          ...(failedCounts ? { failedCounts } : {}),
          sourceReplyDeliveryMode: "message_tool_only",
          observedReplyDelivery: true,
        };
      });
      const deliver = vi.fn().mockResolvedValue(undefined);
      const fail = vi.fn().mockResolvedValue(undefined);

      await expect(
        dispatchRuntimeReply({
          core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
          cfg: {} as any,
          session: { ctx: { SessionKey: `session-observed-${_label.replace(" ", "-")}` } } as any,
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

      expect(deliver).toHaveBeenLastCalledWith(
        { text: "", channelData: { wecomExternalFinalDelivered: true } },
        { kind: "final" },
      );
      expect(fail).not.toHaveBeenCalled();
    },
  );

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
