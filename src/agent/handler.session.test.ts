import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  sendAgentApiText: vi.fn(async () => undefined),
}));

vi.mock("../transport/agent-api/client.js", () => ({
  downloadAgentApiMedia: vi.fn(),
  downloadUpstreamAgentApiMedia: vi.fn(),
  sendAgentApiText: apiMocks.sendAgentApiText,
  sendUpstreamAgentApiText: vi.fn(),
}));

vi.mock("../transport/agent-api/delivery.js", () => ({
  deliverAgentApiMedia: vi.fn(),
}));

import { handleAgentWebhook } from "./handler.js";

describe("Agent callback session metadata", () => {
  beforeEach(() => {
    apiMocks.sendAgentApiText.mockReset();
    apiMocks.sendAgentApiText.mockResolvedValue(undefined);
  });

  it("waits for metadata settlement before dispatching to OpenClaw", async () => {
    let releaseMetadata!: () => void;
    const metadataTask = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    let markRecordStarted!: () => void;
    const recordStarted = new Promise<void>((resolve) => {
      markRecordStarted = resolve;
    });
    let markDispatchSettled!: () => void;
    const dispatchSettled = new Promise<void>((resolve) => {
      markDispatchSettled = resolve;
    });
    const dispatch = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "最终正文" }, { kind: "final" });
      markDispatchSettled();
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    const recordInboundSession = vi.fn(async (params) => {
      params.trackSessionMetaTask?.(metadataTask);
      markRecordStarted();
    });
    const core = {
      channel: {
        commands: {
          shouldComputeCommandAuthorized: vi.fn(() => false),
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => true),
        },
        media: { saveMediaBuffer: vi.fn() },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          finalizeInboundContext: vi.fn((ctx) => ctx),
          formatAgentEnvelope: vi.fn(({ body }) => body),
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            accountId: "agent-test",
            agentId: "main",
            matchedBy: "binding",
            sessionKey: "agent:main:wecom:agent-test:dm:alice",
          })),
        },
        session: {
          readSessionUpdatedAt: vi.fn(() => undefined),
          recordInboundSession,
          resolveStorePath: vi.fn(() => "/tmp/wecom-agent-session-test.json"),
        },
      },
    };

    await handleAgentWebhook({
      req: {
        method: "POST",
        socket: { remoteAddress: "127.0.0.1" },
        url: "/wecom/agent",
      } as any,
      res: { statusCode: 0, end: vi.fn(), setHeader: vi.fn() } as any,
      verifiedPost: {
        timestamp: "1",
        nonce: "nonce",
        signature: "signature",
        encrypted: "encrypted",
        decrypted: "decrypted",
        parsed: {
          AgentID: "100001",
          Content: "检查会话",
          FromUserName: "alice",
          MsgId: randomUUID(),
          MsgType: "text",
          ToUserName: "corp-test",
        } as any,
      },
      agent: {
        accountId: "agent-test",
        corpId: "corp-test",
        corpSecret: "secret",
        agentId: 100001,
        config: { dm: { policy: "open" }, upstreamCorps: [] },
      } as any,
      config: {} as any,
      core: core as any,
    });

    await recordStarted;
    expect(dispatch).not.toHaveBeenCalled();
    releaseMetadata();
    await dispatchSettled;
    expect(dispatch).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(apiMocks.sendAgentApiText).toHaveBeenCalledOnce());
  });

  it("serializes an in-flight processing notice before the final reply", async () => {
    vi.useFakeTimers();
    try {
      let releaseProgress!: () => void;
      const progressPending = new Promise<void>((resolve) => {
        releaseProgress = resolve;
      });
      let markProgressStarted!: () => void;
      const progressStarted = new Promise<void>((resolve) => {
        markProgressStarted = resolve;
      });
      let markFinalSent!: () => void;
      const finalSent = new Promise<void>((resolve) => {
        markFinalSent = resolve;
      });
      apiMocks.sendAgentApiText.mockImplementation(async ({ text }: { text: string }) => {
        if (text === "正在处理中，请稍候...") {
          markProgressStarted();
          await progressPending;
        }
        if (text === "最终正文") {
          markFinalSent();
        }
      });

      let releaseFinal!: () => void;
      const finalReady = new Promise<void>((resolve) => {
        releaseFinal = resolve;
      });
      let markDispatchStarted!: () => void;
      const dispatchStarted = new Promise<void>((resolve) => {
        markDispatchStarted = resolve;
      });
      let markDispatchFinished!: () => void;
      const dispatchFinished = new Promise<void>((resolve) => {
        markDispatchFinished = resolve;
      });
      const dispatch = vi.fn(async ({ dispatcherOptions }) => {
        markDispatchStarted();
        await finalReady;
        await dispatcherOptions.deliver({ text: "最终正文" }, { kind: "final" });
        markDispatchFinished();
        return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
      });
      const core = {
        channel: {
          commands: {
            shouldComputeCommandAuthorized: vi.fn(() => false),
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => true),
          },
          media: { saveMediaBuffer: vi.fn() },
          reply: {
            dispatchReplyWithBufferedBlockDispatcher: dispatch,
            finalizeInboundContext: vi.fn((ctx) => ctx),
            formatAgentEnvelope: vi.fn(({ body }) => body),
            resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          },
          routing: {
            resolveAgentRoute: vi.fn(() => ({
              accountId: "agent-test",
              agentId: "main",
              matchedBy: "binding",
              sessionKey: "agent:main:wecom:agent-test:dm:alice",
            })),
          },
          session: {
            readSessionUpdatedAt: vi.fn(() => undefined),
            recordInboundSession: vi.fn(async () => undefined),
            resolveStorePath: vi.fn(() => "/tmp/wecom-agent-session-test.json"),
          },
        },
      };

      await handleAgentWebhook({
        req: {
          method: "POST",
          socket: { remoteAddress: "127.0.0.1" },
          url: "/wecom/agent",
        } as any,
        res: { statusCode: 0, end: vi.fn(), setHeader: vi.fn() } as any,
        verifiedPost: {
          timestamp: "1",
          nonce: "nonce",
          signature: "signature",
          encrypted: "encrypted",
          decrypted: "decrypted",
          parsed: {
            AgentID: "100001",
            Content: "检查发送顺序",
            FromUserName: "alice",
            MsgId: randomUUID(),
            MsgType: "text",
            ToUserName: "corp-test",
          } as any,
        },
        agent: {
          accountId: "agent-test",
          corpId: "corp-test",
          corpSecret: "secret",
          agentId: 100001,
          config: { dm: { policy: "open" }, upstreamCorps: [] },
        } as any,
        config: {} as any,
        core: core as any,
      });

      await dispatchStarted;
      await vi.advanceTimersByTimeAsync(5_000);
      await progressStarted;
      releaseFinal();
      await Promise.resolve();
      await Promise.resolve();

      expect(apiMocks.sendAgentApiText).toHaveBeenCalledTimes(1);
      releaseProgress();
      await finalSent;
      await dispatchFinished;
      expect(apiMocks.sendAgentApiText.mock.calls.map(([call]) => call.text)).toEqual([
        "正在处理中，请稍候...",
        "最终正文",
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
