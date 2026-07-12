import { beforeEach, describe, expect, it, vi } from "vitest";

import { decryptWecomMediaWithMeta } from "../../media.js";
import { WECOM_PKCS7_BLOCK_SIZE } from "../../crypto.js";
import { StreamStore } from "../../store/stream-batch-store.js";
import * as runtimeModule from "../../runtime.js";
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

function createTarget(core: any, error = vi.fn(), mediaMaxMb = 16) {
  return {
    account: {
      accountId: "default",
      encodingAESKey: "account-aes-key",
      config: {},
    } as any,
    config: { channels: { wecom: { mediaMaxMb } } } as any,
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
    expect(ctx.Attachments[0]).toEqual(
      expect.objectContaining({
        path: "/tmp/spec.pdf",
        url: "file:///tmp/spec.pdf",
        remoteUrl: "file:///tmp/spec.pdf",
      }),
    );
    expect(stageWecomInboundMediaForSession).toHaveBeenCalledTimes(2);
    expect(stageWecomInboundMediaForSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mediaPath: "/tmp/spec.pdf", filename: "spec.pdf" }),
    );
    expect(stageWecomInboundMediaForSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mediaPath: "/tmp/photo.png", filename: "photo.png" }),
    );
  });

  it("saves each attachment before downloading the next one", async () => {
    const { core, saveMediaBuffer } = createCore();
    vi.mocked(decryptWecomMediaWithMeta)
      .mockResolvedValueOnce({
        buffer: Buffer.from("first"),
        sourceContentType: "image/png",
        sourceFilename: "first.png",
        sourceUrl: "https://example.com/first.png",
      })
      .mockImplementationOnce(async () => {
        expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
        return {
          buffer: Buffer.from("second"),
          sourceContentType: "image/png",
          sourceFilename: "second.png",
          sourceUrl: "https://example.com/second.png",
        };
      });
    const orchestrator = createBotStreamOrchestrator({
      streamStore: new StreamStore(),
      recordBotOperationalEvent: vi.fn(),
    });

    await orchestrator.startAgentForStream({
      target: createTarget(core),
      accountId: "default",
      streamId: "stream-incremental-media",
      msg: {
        msgid: "M1",
        msgtype: "image",
        chattype: "single",
        from: { userid: "linky" },
        image: { url: "https://example.com/first.png" },
      },
      mergedMessages: [
        {
          msgid: "M1",
          msgtype: "image",
          chattype: "single",
          from: { userid: "linky" },
          image: { url: "https://example.com/first.png" },
        },
        {
          msgid: "M2",
          msgtype: "image",
          chattype: "single",
          from: { userid: "linky" },
          image: { url: "https://example.com/second.png" },
        },
      ],
    } as any);

    expect(saveMediaBuffer).toHaveBeenCalledTimes(2);
  });

  it("limits attachment count before downloading an unbounded merged burst", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockResolvedValue({
      buffer: Buffer.from("small-image"),
      sourceContentType: "image/png",
      sourceFilename: "image.png",
      sourceUrl: "https://example.com/image.png",
    });
    const { core, recordInboundSession, saveMediaBuffer } = createCore();
    const orchestrator = createBotStreamOrchestrator({
      streamStore: new StreamStore(),
      recordBotOperationalEvent: vi.fn(),
    });
    const mergedMessages = Array.from({ length: 10 }, (_, index) => ({
      msgid: `M${index + 1}`,
      msgtype: "image",
      chattype: "single",
      from: { userid: "linky" },
      image: { url: `https://example.com/${index + 1}.png` },
    }));

    await orchestrator.startAgentForStream({
      target: createTarget(core),
      accountId: "default",
      streamId: "stream-media-count-limit",
      msg: mergedMessages[0],
      mergedMessages,
    } as any);

    expect(decryptWecomMediaWithMeta).toHaveBeenCalledTimes(8);
    expect(saveMediaBuffer).toHaveBeenCalledTimes(8);
    const ctx = recordInboundSession.mock.calls[0]?.[0]?.ctx;
    expect(ctx.Attachments).toHaveLength(8);
    expect(ctx.RawBody).toContain("单批次最多处理 8 个附件");
    expect(ctx.RawBody).not.toContain("https://example.com/9.png");
    expect(ctx.RawBody).not.toContain("https://example.com/10.png");
    expect(ctx.MediaFailures).toEqual([
      { name: "第9个附件", error: "单批次最多处理 8 个附件，已跳过" },
      { name: "第10个附件", error: "单批次最多处理 8 个附件，已跳过" },
    ]);
  });

  it("shares the configured media byte budget across the merged batch", async () => {
    const firstBytes = 700 * 1024;
    const aggregateBytes = 1024 * 1024;
    vi.mocked(decryptWecomMediaWithMeta)
      .mockResolvedValueOnce({
        buffer: Buffer.alloc(firstBytes, 1),
        sourceContentType: "image/png",
        sourceFilename: "first.png",
        sourceUrl: "https://example.com/first.png",
      })
      .mockImplementationOnce(async (_url, _aesKey, options) => {
        expect(options?.maxBytes).toBe(
          aggregateBytes - firstBytes + WECOM_PKCS7_BLOCK_SIZE,
        );
        throw new Error(`response body too large (>${options?.maxBytes} bytes)`);
      });
    const { core, recordInboundSession, saveMediaBuffer } = createCore();
    const orchestrator = createBotStreamOrchestrator({
      streamStore: new StreamStore(),
      recordBotOperationalEvent: vi.fn(),
    });

    await orchestrator.startAgentForStream({
      target: createTarget(core, vi.fn(), 1),
      accountId: "default",
      streamId: "stream-media-byte-limit",
      msg: {
        msgid: "M1",
        msgtype: "image",
        chattype: "single",
        from: { userid: "linky" },
        image: { url: "https://example.com/first.png" },
      },
      mergedMessages: [
        {
          msgid: "M1",
          msgtype: "image",
          chattype: "single",
          from: { userid: "linky" },
          image: { url: "https://example.com/first.png" },
        },
        {
          msgid: "M2",
          msgtype: "image",
          chattype: "single",
          from: { userid: "linky" },
          image: { url: "https://example.com/second.png" },
        },
      ],
    } as any);

    expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
    const ctx = recordInboundSession.mock.calls[0]?.[0]?.ctx;
    expect(ctx.Attachments).toHaveLength(1);
    expect(ctx.RawBody).toContain("附件超过本批次大小限制");
    expect(ctx.RawBody.match(/附件超过本批次大小限制/g)).toHaveLength(1);
    expect(ctx.MediaFailures).toEqual([
      { name: "second.png", error: "附件超过本批次大小限制" },
    ]);
  });

  it("settles merged acknowledgements as failed when fail-closed routing rejects the batch", async () => {
    const { core } = createCore();
    core.channel.routing.resolveAgentRoute.mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:wecom:default:direct:linky",
      matchedBy: "default",
    });
    const target = createTarget(core);
    target.config.channels.wecom.routing = { failClosedOnDefaultRoute: true };
    const streamStore = new StreamStore();
    const streamId = streamStore.createStream({});
    const ackStreamId = streamStore.createStream({ msgid: "ACK-ROUTING" });
    streamStore.addAckStreamForBatch({ batchStreamId: streamId, ackStreamId });
    const orchestrator = createBotStreamOrchestrator({
      streamStore,
      recordBotOperationalEvent: vi.fn(),
    });

    await orchestrator.startAgentForStream({
      target,
      accountId: "default",
      streamId,
      msg: {
        msgid: "M-ROUTING",
        msgtype: "text",
        chattype: "single",
        from: { userid: "linky" },
        text: { content: "hello" },
      },
    } as any);

    expect(streamStore.getStream(streamId)?.error).toContain("未绑定 OpenClaw Agent");
    expect(streamStore.getStream(ackStreamId)).toEqual(
      expect.objectContaining({
        content: "⚠️ 合并处理失败，请查看上一条错误信息或重试。",
        finished: true,
      }),
    );
  });

  it("settles merged acknowledgements as failed when the runtime is unavailable", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(runtimeModule, "getWecomRuntime").mockImplementationOnce(() => {
        throw new Error("runtime not ready");
      });
      const streamStore = new StreamStore();
      const orchestrator = createBotStreamOrchestrator({
        streamStore,
        recordBotOperationalEvent: vi.fn(),
      });
      streamStore.setFlushHandler((pending) => {
        void orchestrator.flushPending(pending);
      });
      const target = createTarget({});
      const batch = streamStore.addPendingMessage({
        conversationKey: "wecom:default:linky:linky",
        target,
        msg: {
          msgid: "M1",
          msgtype: "image",
          chattype: "single",
          from: { userid: "linky" },
          image: { url: "https://example.com/one.png" },
        } as any,
        msgContent: "[image]",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });
      const merged = streamStore.addPendingMessage({
        conversationKey: "wecom:default:linky:linky",
        target,
        msg: {
          msgid: "M2",
          msgtype: "text",
          chattype: "single",
          from: { userid: "linky" },
          text: { content: "分析图片" },
        } as any,
        msgContent: "分析图片",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });
      expect(merged.status).toBe("active_merged");
      const ackStreamId = streamStore.createStream({ msgid: "ACK-RUNTIME" });
      streamStore.addAckStreamForBatch({ batchStreamId: batch.streamId, ackStreamId });

      await vi.advanceTimersByTimeAsync(11);
      await vi.waitFor(() => expect(streamStore.getStream(batch.streamId)?.finished).toBe(true));

      expect(streamStore.getStream(batch.streamId)?.error).toContain("runtime not ready");
      expect(streamStore.getStream(ackStreamId)).toEqual(
        expect.objectContaining({
          content: "⚠️ 合并处理失败，请查看上一条错误信息或重试。",
          finished: true,
        }),
      );
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("keeps sandbox-relative attachment URLs relative to the agent workspace", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockResolvedValue({
      buffer: Buffer.from("%PDF-1.7 sandbox"),
      sourceContentType: "application/pdf",
      sourceFilename: "report.pdf",
      sourceUrl: "https://example.com/report.pdf",
    });
    stageWecomInboundMediaForSession.mockResolvedValueOnce("media/inbound/report.pdf");
    const { core, recordInboundSession } = createCore();
    const orchestrator = createBotStreamOrchestrator({
      streamStore: new StreamStore(),
      recordBotOperationalEvent: vi.fn(),
    });

    await orchestrator.startAgentForStream({
      target: createTarget(core),
      accountId: "default",
      streamId: "stream-sandbox-relative-media",
      msg: {
        msgid: "M1",
        msgtype: "file",
        chattype: "single",
        from: { userid: "linky" },
        file: { url: "https://example.com/report.pdf" },
      },
    } as any);

    const ctx = recordInboundSession.mock.calls[0]?.[0]?.ctx;
    expect(ctx.MediaPath).toBe("media/inbound/report.pdf");
    expect(ctx.MediaPaths).toEqual(["media/inbound/report.pdf"]);
    expect(ctx.Attachments[0]).toEqual(
      expect.objectContaining({
        path: "media/inbound/report.pdf",
        url: "media/inbound/report.pdf",
        remoteUrl: "media/inbound/report.pdf",
      }),
    );
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

  it("does not expose an attachment that failed session staging", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockResolvedValue({
      buffer: Buffer.from("report"),
      sourceContentType: "application/pdf",
      sourceFilename: "report.pdf",
      sourceUrl: "https://example.com/report.pdf",
    });
    stageWecomInboundMediaForSession.mockRejectedValueOnce(new Error("workspace unavailable"));
    const { core, recordInboundSession } = createCore();
    const orchestrator = createBotStreamOrchestrator({
      streamStore: new StreamStore(),
      recordBotOperationalEvent: vi.fn(),
    });

    await orchestrator.startAgentForStream({
      target: createTarget(core),
      accountId: "default",
      streamId: "stream-stage-failure",
      msg: {
        msgid: "M1",
        msgtype: "file",
        chattype: "single",
        from: { userid: "linky" },
        file: { url: "https://example.com/report.pdf" },
      },
    } as any);

    const ctx = recordInboundSession.mock.calls[0]?.[0]?.ctx;
    expect(ctx.Attachments).toBeUndefined();
    expect(ctx.MediaPaths).toBeUndefined();
    expect(ctx.RawBody).toContain("[附件处理失败: report.pdf - workspace unavailable]");
  });

  it("waits for session metadata before dispatching the webhook reply", async () => {
    let releaseMetadata!: () => void;
    const metadataTask = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    const { core, recordInboundSession } = createCore();
    recordInboundSession.mockImplementation(async (params) => {
      params.trackSessionMetaTask?.(metadataTask);
    });
    const dispatch = core.channel.reply.dispatchReplyWithBufferedBlockDispatcher;
    const orchestrator = createBotStreamOrchestrator({
      streamStore: new StreamStore(),
      recordBotOperationalEvent: vi.fn(),
    });

    const operation = orchestrator.startAgentForStream({
      target: createTarget(core),
      accountId: "default",
      streamId: "stream-metadata",
      msg: {
        msgid: "M1",
        msgtype: "text",
        chattype: "single",
        from: { userid: "linky" },
        text: { content: "hello" },
      },
    } as any);
    await vi.waitFor(() => expect(recordInboundSession).toHaveBeenCalledOnce());
    expect(dispatch).not.toHaveBeenCalled();

    releaseMetadata();
    await operation;
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
