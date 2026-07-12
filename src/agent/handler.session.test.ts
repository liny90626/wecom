import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

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
});
