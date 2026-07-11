import { beforeEach, describe, expect, it, vi } from "vitest";

import { decryptWecomMediaWithMeta } from "../../media.js";
import { StreamStore } from "../../store/stream-batch-store.js";
import { createBotStreamOrchestrator } from "./stream-orchestrator.js";

const { finalizeBotStream, stageWecomInboundMediaForSession, createBotReplyDispatcher } = vi.hoisted(
  () => ({
    finalizeBotStream: vi.fn(async () => {}),
    stageWecomInboundMediaForSession: vi.fn(async ({ mediaPath }: { mediaPath: string }) => mediaPath),
    createBotReplyDispatcher: vi.fn(() => ({
      deliver: vi.fn(async () => {}),
      onError: vi.fn(),
    })),
  }),
);

vi.mock("../../media.js", () => ({
  decryptWecomMediaWithMeta: vi.fn(),
}));

vi.mock("./stream-finalizer.js", () => ({
  finalizeBotStream,
}));

vi.mock("./sandbox-media.js", () => ({
  stageWecomInboundMediaForSession,
}));

vi.mock("./stream-delivery.js", () => ({
  createBotReplyDispatcher,
}));

function createCore() {
  const recordInboundSession = vi.fn(async () => {});
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => {});
  const finalizeInboundContext = vi.fn((ctx) => ctx);
  const saveMediaBuffer = vi.fn(async (_buffer, contentType, _kind, _maxBytes, filename) => ({
    path: `/tmp/${filename ?? "media.bin"}`,
    contentType,
  }));

  return {
    core: {
      logging: { shouldLogVerbose: vi.fn(() => false) },
      channel: {
        media: { saveMediaBuffer },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "knowledge",
            accountId: "default",
            sessionKey: "agent:knowledge:wecom:default:direct:linky",
            matchedBy: "binding",
          })),
        },
        commands: {
          shouldComputeCommandAuthorized: vi.fn(() => false),
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => true),
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/wecom-store"),
          readSessionUpdatedAt: vi.fn(() => undefined),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatAgentEnvelope: vi.fn(({ body }) => `ENV:${body}`),
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher,
        },
        text: { resolveMarkdownTableMode: vi.fn(() => "smart") },
      },
    } as any,
    recordInboundSession,
    saveMediaBuffer,
  };
}

function createTarget(core: any, error = vi.fn()) {
  return {
    account: {
      accountId: "default",
      encodingAESKey: "account-aes-key",
      config: {},
    } as any,
    config: { channels: { wecom: { mediaMaxMb: 16 } } } as any,
    runtime: { log: vi.fn(), error },
    core,
    path: "/wecom",
  };
}

describe("createBotStreamOrchestrator merged media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(decryptWecomMediaWithMeta).mockReset();
    stageWecomInboundMediaForSession.mockReset();
    stageWecomInboundMediaForSession.mockImplementation(
      async ({ mediaPath }: { mediaPath: string }) => mediaPath,
    );
  });

  it("passes every successful attachment from an ordered merged batch to OpenClaw", async () => {
    vi.mocked(decryptWecomMediaWithMeta)
      .mockResolvedValueOnce({
        buffer: Buffer.from("%PDF-1.7 merged"),
        sourceContentType: "application/pdf",
        sourceFilename: "spec.pdf",
        sourceUrl: "https://example.com/spec.pdf",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        sourceContentType: "image/png",
        sourceFilename: "photo.png",
        sourceUrl: "https://example.com/photo.png",
      });
    const { core, recordInboundSession } = createCore();
    const orchestrator = createBotStreamOrchestrator({
      streamStore: new StreamStore(),
      recordBotOperationalEvent: vi.fn(),
    });

    await orchestrator.startAgentForStream({
      target: createTarget(core),
      accountId: "default",
      streamId: "stream-merged-media",
      msg: {
        msgid: "M1",
        msgtype: "text",
        chattype: "single",
        from: { userid: "linky" },
        text: { content: "请结合这些附件回答" },
      },
      mergedMessages: [
        {
          msgid: "M1",
          msgtype: "text",
          chattype: "single",
          from: { userid: "linky" },
          text: { content: "请结合这些附件回答" },
        },
        {
          msgid: "M2",
          msgtype: "file",
          chattype: "single",
          from: { userid: "linky" },
          file: { url: "https://example.com/spec.pdf" },
        },
        {
          msgid: "M3",
          msgtype: "image",
          chattype: "single",
          from: { userid: "linky" },
          image: { url: "https://example.com/photo.png" },
        },
      ],
    } as any);

    const ctx = recordInboundSession.mock.calls[0]?.[0]?.ctx;
    expect(ctx).toEqual(
      expect.objectContaining({
        RawBody: "请结合这些附件回答\n[file]\n[image]",
        MediaPath: "/tmp/spec.pdf",
        MediaType: "application/pdf",
        MediaPaths: ["/tmp/spec.pdf", "/tmp/photo.png"],
        MediaTypes: ["application/pdf", "image/png"],
      }),
    );
    expect(ctx.Attachments.map((attachment: { name: string }) => attachment.name)).toEqual([
      "spec.pdf",
      "photo.png",
    ]);
    expect(stageWecomInboundMediaForSession).toHaveBeenCalledTimes(2);
  });

  it("keeps successful attachments and makes a later save failure visible", async () => {
    vi.mocked(decryptWecomMediaWithMeta)
      .mockResolvedValueOnce({
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        sourceContentType: "image/png",
        sourceFilename: "ok.png",
        sourceUrl: "https://example.com/ok.png",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from("%PDF-1.7 bad"),
        sourceContentType: "application/pdf",
        sourceFilename: "bad.pdf",
        sourceUrl: "https://example.com/bad.pdf",
      });
    const { core, recordInboundSession, saveMediaBuffer } = createCore();
    saveMediaBuffer
      .mockResolvedValueOnce({ path: "/tmp/ok.png", contentType: "image/png" })
      .mockRejectedValueOnce(new Error("disk full"));
    const runtimeError = vi.fn();
    const orchestrator = createBotStreamOrchestrator({
      streamStore: new StreamStore(),
      recordBotOperationalEvent: vi.fn(),
    });

    await orchestrator.startAgentForStream({
      target: createTarget(core, runtimeError),
      accountId: "default",
      streamId: "stream-save-failure",
      msg: {
        msgid: "M1",
        msgtype: "image",
        chattype: "single",
        from: { userid: "linky" },
        image: { url: "https://example.com/ok.png" },
      },
      mergedMessages: [
        {
          msgid: "M1",
          msgtype: "image",
          chattype: "single",
          from: { userid: "linky" },
          image: { url: "https://example.com/ok.png" },
        },
        {
          msgid: "M2",
          msgtype: "file",
          chattype: "single",
          from: { userid: "linky" },
          file: { url: "https://example.com/bad.pdf" },
        },
      ],
    } as any);

    const ctx = recordInboundSession.mock.calls[0]?.[0]?.ctx;
    expect(ctx.RawBody).toContain("[附件处理失败: bad.pdf - disk full]");
    expect(ctx.MediaPaths).toEqual(["/tmp/ok.png"]);
    expect(ctx.MediaFailures).toEqual([{ name: "bad.pdf", error: "disk full" }]);
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("Failed to save inbound media"));
  });
});
