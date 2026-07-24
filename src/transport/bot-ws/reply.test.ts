import os from "node:os";
import path from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import { registerBotWsPushHandle, unregisterBotWsPushHandle } from "../../runtime.js";
import { uploadAndSendBotWsMedia } from "./media.js";
import { __resetBotWsReplyTestState, createBotWsReplyHandle } from "./reply.js";

vi.mock("./media.js", () => ({
  uploadAndSendBotWsMedia: vi.fn(),
}));

type ReplyHandleParams = Parameters<typeof createBotWsReplyHandle>[0];
const FINAL_COMPLETION_MARKER = "（回复完毕）";

// This suite is fake-timer heavy: individual tests advance simulated hours
// and flush hundreds of microtasks, so their WALL-CLOCK time under a fully
// parallel cold-cache run can exceed the default 5s without anything being
// hung. Scoped here so real hangs elsewhere still fail fast.
vi.setConfig({ testTimeout: 30_000 });

describe("createBotWsReplyHandle", () => {
  let mockClient: import("vitest").Mocked<WSClient>;
  const uploadAndSendBotWsMediaMock = vi.mocked(uploadAndSendBotWsMedia);

  const flushPromises = async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  };

  const drainChunkTimers = async (times = 8) => {
    for (let i = 0; i < times; i += 1) {
      await flushPromises();
      await vi.advanceTimersByTimeAsync(800);
    }
    await flushPromises();
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    __resetBotWsReplyTestState();
    unregisterBotWsPushHandle("default");
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/wecom-reply-state");
    mockClient = {
      replyStream: vi.fn(),
      sendMessage: vi.fn(),
      replyWelcome: vi.fn(),
    } as unknown as import("vitest").Mocked<WSClient>;
    mockClient.replyStream.mockResolvedValue({} as any);
    mockClient.sendMessage.mockResolvedValue({} as any);
    mockClient.replyWelcome.mockResolvedValue({} as any);
    uploadAndSendBotWsMediaMock.mockReset();
    uploadAndSendBotWsMediaMock.mockResolvedValue({ ok: true, messageId: "media-1" } as any);
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: {
        loadConfig: () => ({
          channels: {
            wecom: {},
          },
        }),
      },
    } as any);
  });

  afterEach(() => {
    unregisterBotWsPushHandle("default");
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses configured placeholder content for immediate ws ack", async () => {
    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-1" },
        body: { chatid: "123", chattype: "group" },
        cmd: "aibot_msg_callback",
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });

    vi.advanceTimersByTime(3000);
    // Let promises flush
    await Promise.resolve();

    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { req_id: "req-1" },
      }),
      expect.any(String),
      "正在思考...",
      false,
    );
  });

  it("keeps placeholder alive until the first real ws chunk arrives", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-keepalive" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });

    vi.advanceTimersByTime(3000);
    // Flush the microtasks so `placeholderInFlight` becomes false
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Now trigger the next timer
    vi.advanceTimersByTime(3000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);

    handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });
    await Promise.resolve();

    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { req_id: "req-keepalive" },
      }),
      expect.any(String),
      "最终回复",
      true,
    );

    // Ensure interval is cleared
    vi.advanceTimersByTime(6000);
    await Promise.resolve();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(3);
  });

  it("finishes an opened placeholder stream when the final reply is intentionally empty", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-empty-final-close" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });
    await flushPromises();

    await handle.deliver({ text: "", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    const placeholderCall = mockClient.replyStream.mock.calls[0];
    expect(mockClient.replyStream.mock.calls[1]).toEqual([
      expect.objectContaining({ headers: { req_id: "req-empty-final-close" } }),
      placeholderCall?.[1],
      "",
      true,
    ]);
  });

  it("still finishes an empty final when the placeholder ACK arrives after the normal grace", async () => {
    let resolvePlaceholder: ((value: unknown) => void) | undefined;
    mockClient.replyStream
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePlaceholder = resolve;
          }) as any,
      )
      .mockResolvedValue({} as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-empty-final-late-placeholder" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });
    await flushPromises();

    const finalDelivery = handle.deliver({ text: "" }, { kind: "final" });
    await vi.advanceTimersByTimeAsync(5_600);
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    resolvePlaceholder?.({});
    await vi.advanceTimersByTimeAsync(100);
    await finalDelivery;

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.replyStream.mock.calls[1]?.[3]).toBe(true);
  });

  it("does not reuse the callback req_id for final after the placeholder ACK times out", async () => {
    const ackTimeout = new Error(
      "Reply ack timeout (5000ms) for reqId: req-placeholder-ack-timeout",
    );
    mockClient.replyStream
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(ackTimeout), 5_000);
          }) as any,
      )
      .mockResolvedValue({} as any);
    const onFail = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-placeholder-ack-timeout" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
      onFail,
    });
    await flushPromises();

    const finalDelivery = handle.deliver({ text: "最终正文" }, { kind: "final" });
    await vi.advanceTimersByTimeAsync(5_100);
    await finalDelivery;

    expect(onFail).toHaveBeenCalledWith(ackTimeout);
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: `最终正文\n\n${FINAL_COMPLETION_MARKER}` },
    });
  });

  it("soft-times out hanging placeholders and allows the next keepalive attempt", async () => {
    mockClient.replyStream
      .mockImplementationOnce(() => new Promise(() => undefined) as any)
      .mockResolvedValue({} as any);
    const onFail = vi.fn();
    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-placeholder-timeout" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
      onFail,
    });

    vi.advanceTimersByTime(3000);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_000);
    await flushPromises();
    expect(onFail).not.toHaveBeenCalled();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(3000);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(3);
    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-placeholder-timeout" } }),
      expect.any(String),
      "正在思考...",
      false,
    );
  });

  it("does not auto-send placeholder when disabled", async () => {
    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-2" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    expect(mockClient.replyStream).not.toHaveBeenCalled();
  });

  it("defers the placeholder until the runtime activates the reply handle", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-deferred-activation" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
      deferActivation: true,
    });

    await vi.advanceTimersByTimeAsync(6_000);
    expect(mockClient.replyStream).not.toHaveBeenCalled();

    handle.activate?.();
    handle.activate?.();
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-deferred-activation" } }),
      expect.any(String),
      "正在思考...",
      false,
    );

    await handle.deliver({ text: "已激活", isReasoning: false }, { kind: "final" });
  });

  it("coalesces pending previews and sends only the latest after ACK clears", async () => {
    const nonBlockingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    let pendingAck = true;
    nonBlockingClient.replyStreamNonBlocking = vi.fn(() =>
      Promise.resolve(pendingAck ? "skipped" : ({} as any)),
    );
    nonBlockingClient.hasPendingReplyAck = vi.fn(() => pendingAck);

    const handle = createBotWsReplyHandle({
      client: nonBlockingClient,
      frame: {
        headers: { req_id: "req-preview-coalesced" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "第一版", isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: "第二版", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(nonBlockingClient.replyStreamNonBlocking).not.toHaveBeenCalled();

    pendingAck = false;
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    expect(nonBlockingClient.replyStreamNonBlocking).toHaveBeenCalledTimes(1);
    expect(String(nonBlockingClient.replyStreamNonBlocking.mock.calls[0]?.[2])).toContain("第二版");
  });

  it("drops an older pending preview when a newer direct preview succeeds first", async () => {
    const nonBlockingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    let pendingAck = true;
    nonBlockingClient.hasPendingReplyAck = vi.fn(() => pendingAck);
    nonBlockingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({} as any);

    const handle = createBotWsReplyHandle({
      client: nonBlockingClient,
      frame: {
        headers: { req_id: "req-preview-newer-direct" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "旧版本", isReasoning: false }, { kind: "block" });
    pendingAck = false;
    await handle.deliver({ text: "新版本", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(nonBlockingClient.replyStreamNonBlocking).toHaveBeenCalledTimes(1);
    expect(String(nonBlockingClient.replyStreamNonBlocking.mock.calls[0]?.[2])).toContain("新版本");
  });

  it("keeps a newer pending preview when an older in-flight preview fails", async () => {
    const nonBlockingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    let rejectFirst!: (error: unknown) => void;
    nonBlockingClient.hasPendingReplyAck = vi.fn(() => false);
    nonBlockingClient.replyStreamNonBlocking = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValue({} as any);

    const handle = createBotWsReplyHandle({
      client: nonBlockingClient,
      frame: {
        headers: { req_id: "req-preview-newer-after-failure" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const firstDelivery = handle.deliver({ text: "旧版本", isReasoning: false }, { kind: "block" });
    await flushPromises();
    await handle.deliver({ text: "新版本", isReasoning: false }, { kind: "block" });
    rejectFirst(new Error("temporary preview failure"));
    await firstDelivery;
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(nonBlockingClient.replyStreamNonBlocking).toHaveBeenCalledTimes(2);
    expect(String(nonBlockingClient.replyStreamNonBlocking.mock.calls[1]?.[2])).toContain("新版本");
  });

  it("starts recurring background status when a pending preview never becomes writable", async () => {
    const nonBlockingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    nonBlockingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue("skipped");
    nonBlockingClient.hasPendingReplyAck = vi.fn(() => true);
    const handle = createBotWsReplyHandle({
      client: nonBlockingClient,
      frame: {
        headers: { req_id: "req-preview-pending-expired" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "正在读取材料" }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(5_600);
    await flushPromises();

    // The channel died early, but the background notice is held until the
    // task has been processing for 9 minutes.
    expect(mockClient.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content)).toBe(
      "执行长任务中，当前用时9m00s",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(String((mockClient.sendMessage.mock.calls[1]?.[1] as any).markdown.content)).toBe(
      "执行长任务中，当前用时10m00s",
    );
  });

  it("streams non-reasoning block previews and sends the accumulated final once", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-blocks" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "第一段", isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: "第二段", isReasoning: false }, { kind: "block" });
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-blocks" } }),
      expect.any(String),
      "第一段",
      false,
    );

    await handle.deliver({ text: "收尾", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-blocks" } }),
      expect.any(String),
      "第一段\n第二段\n收尾",
      true,
    );
  });

  it("preserves a partial source reply when external delivery closes the stream", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-external-final-close" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "已输出一半", isReasoning: false }, { kind: "block" });
    handle.markExternalActivity?.();
    await handle.deliver(
      {
        text: "",
        isReasoning: false,
        channelData: { wecomExternalFinalDelivered: true },
      },
      { kind: "final" },
    );

    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-external-final-close" } }),
      expect.any(String),
      "已输出一半",
      true,
    );
  });

  it("does not re-push a partial source reply when external delivery closes an expired stream", async () => {
    const expiredError = {
      headers: { req_id: "req-external-expired-close" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-external-expired-close" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "已输出一半", isReasoning: false }, { kind: "block" });
    handle.markExternalActivity?.();
    await handle.deliver(
      {
        text: "",
        isReasoning: false,
        channelData: { wecomExternalFinalDelivered: true },
      },
      { kind: "final" },
    );

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    [
      "ambiguous",
      new Error("Reply ack timeout (5000ms) for reqId: aibot_send_msg_external-final"),
    ],
    ["definitive", Object.assign(new Error("active push rejected"), { errcode: 95001 })],
  ])("cancels a pending %s final retry after external delivery", async (_label, pushError) => {
    const expiredError = {
      headers: { req_id: "req-external-final-cancel-retry" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    const sendMarkdown = vi.fn().mockRejectedValueOnce(pushError).mockResolvedValue(undefined);
    registerBotWsPushHandle("default", {
      isConnected: () => true,
      sendMarkdown,
      replyCommand: vi.fn(),
      sendMedia: vi.fn(),
    });
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-external-final-cancel-retry" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "不应再次发送的旧 final" }, { kind: "final" });
    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await handle.deliver(
      { text: "", channelData: { wecomExternalFinalDelivered: true } },
      { kind: "final" },
    );

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200_000);
    await flushPromises();
    expect(sendMarkdown).toHaveBeenCalledTimes(1);
  });

  it("does not rearm a retry that fails after external delivery settles it", async () => {
    const expiredError = {
      headers: { req_id: "req-external-final-inflight-retry" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    const firstPushError = new Error(
      "Reply ack timeout (5000ms) for reqId: aibot_send_msg_external-inflight",
    );
    let rejectInflightRetry: ((error: Error) => void) | undefined;
    const sendMarkdown = vi
      .fn()
      .mockRejectedValueOnce(firstPushError)
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectInflightRetry = reject;
          }),
      )
      .mockResolvedValue(undefined);
    registerBotWsPushHandle("default", {
      isConnected: () => true,
      sendMarkdown,
      replyCommand: vi.fn(),
      sendMedia: vi.fn(),
    });
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-external-final-inflight-retry" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "不应继续补发的旧 final" }, { kind: "final" });
    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();
    expect(sendMarkdown).toHaveBeenCalledTimes(2);

    await handle.deliver(
      { text: "", channelData: { wecomExternalFinalDelivered: true } },
      { kind: "final" },
    );
    rejectInflightRetry?.(new Error("socket closed after external delivery"));
    await flushPromises();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200_000);
    await flushPromises();
    expect(sendMarkdown).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate cumulative block text when final repeats the full answer", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-cumulative-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const block1 = "第一段内容";
    const block2 = `${block1}\n第二段内容`;
    const final = `${block2}\n最终收尾`;

    await handle.deliver({ text: block1, isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: block2, isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: final, isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-cumulative-final" } }),
      expect.any(String),
      final,
      true,
    );
  });

  it("renders reasoning in a progress think block and keeps final body separate", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-block" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "先分析需求", isReasoning: true }, { kind: "block" });
    await handle.deliver({ text: "再核对约束", isReasoning: true }, { kind: "block" });
    await handle.deliver({ text: "最终正文", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.replyStream).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ headers: { req_id: "req-thinking-block" } }),
      expect.any(String),
      "<think>先分析需求</think>\n",
      false,
    );

    const finalText = String(mockClient.replyStream.mock.calls[1]?.[2] ?? "");
    expect(finalText).toBe("最终正文");
    expect(finalText).not.toContain("<think>");
    expect(finalText).not.toContain("先分析需求");
  });

  it("throttles thinking preview updates and keeps them on the same stream", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-throttle" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "第一段思考", isReasoning: true }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(2_999);
    await handle.deliver({ text: "第二段思考", isReasoning: true }, { kind: "block" });
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await handle.deliver({ text: "第三段思考", isReasoning: true }, { kind: "block" });
    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.replyStream.mock.calls[1]?.[1]).toBe(mockClient.replyStream.mock.calls[0]?.[1]);
    expect(String(mockClient.replyStream.mock.calls[1]?.[2] ?? "")).toContain("第三段思考");
    expect(String(mockClient.replyStream.mock.calls[1]?.[2] ?? "")).not.toContain("dbg-r");
  });

  it("strips markup from thinking content before wrapping it in a progress think block", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-sanitize" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      { text: "先<think>内部</think><script>alert(1)</script>结束", isReasoning: true },
      { kind: "block" },
    );
    await handle.deliver({ text: "最终正文", isReasoning: false }, { kind: "final" });

    const progressText = String(mockClient.replyStream.mock.calls[0]?.[2] ?? "");
    const finalText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(progressText).toContain("<think>先内部alert(1)结束</think>");
    expect(progressText).not.toContain("<script>");
    expect(progressText.match(/<think>/g)).toHaveLength(1);
    expect(progressText.match(/<\/think>/g)).toHaveLength(1);
    expect(finalText).toBe("最终正文");
  });

  it.each(["分析完成<--", "分析完成<!--"])(
    "strips a dangling comment marker from thinking content: %s",
    async (thinkingText) => {
      const handle = createBotWsReplyHandle({
        client: mockClient,
        frame: {
          headers: { req_id: "req-thinking-dangling-comment" },
          body: { from: { userid: "alice" }, chattype: "single" },
        } as unknown as ReplyHandleParams["frame"],
        accountId: "default",
        inboundKind: "text",
        autoSendPlaceholder: false,
      });

      await handle.deliver({ text: thinkingText, isReasoning: true }, { kind: "block" });

      const progressText = String(mockClient.replyStream.mock.calls[0]?.[2] ?? "");
      expect(progressText).toContain("<think>分析完成</think>");
      expect(progressText).not.toContain("<--");
      expect(progressText).not.toContain("<!--");
    },
  );

  it("keeps body text that was truncated by a large thinking preview", async () => {
    const expiredError = {
      headers: { req_id: "req-thinking-body-byte-budget" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream
      .mockResolvedValueOnce({} as any)
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(expiredError);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-body-byte-budget" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const body = "文".repeat(3_000);

    await handle.deliver(
      { text: "思".repeat(2_500), isReasoning: true },
      { kind: "block" },
    );
    await vi.advanceTimersByTimeAsync(4_000);
    await handle.deliver({ text: body, isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(4_000);
    await handle.deliver({ text: "TAIL", isReasoning: false }, { kind: "final" });

    const preview = String(mockClient.replyStream.mock.calls[1]?.[2] ?? "");
    const visibleBodyChars = preview.match(/文/g)?.length ?? 0;
    expect(visibleBodyChars).toBeGreaterThan(0);
    expect(visibleBodyChars).toBeLessThan(body.length);
    expect(preview.length).toBeLessThanOrEqual(3_500);
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(12_000);

    const pushed = mockClient.sendMessage.mock.calls
      .map((call) => String((call[1] as any).markdown.content))
      .join("\n");
    expect(pushed).toContain("TAIL");
    expect((pushed.match(/文/g)?.length ?? 0) + visibleBodyChars).toBe(body.length);
  });

  it("keeps Fast auto-off visible after the body preview freezes", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-fast-after-frozen-preview" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const fastText = "💨Fast: auto-off(62s>=60s)";

    await handle.deliver(
      { text: "正".repeat(3_000), isReasoning: false },
      { kind: "block" },
    );
    await vi.advanceTimersByTimeAsync(16_000);
    await handle.deliver(
      {
        text: fastText,
        channelData: { openclawProgressKind: "fast-mode-auto" },
      },
      { kind: "block" },
    );

    const fastPreview = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(fastPreview).toContain(fastText);
    expect(fastPreview.length).toBeLessThanOrEqual(3_500);
    expect(Buffer.byteLength(fastPreview, "utf8")).toBeLessThanOrEqual(12_000);
  });

  it("does not pass literal think tags through normal final body text", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-literal-think-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      { text: "发送：`<think>这里只是示例</think>`这里是正文", isReasoning: false },
      { kind: "final" },
    );

    const finalText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalText).toContain("`&lt;think&gt;这里只是示例&lt;/think&gt;`这里是正文");
    expect(finalText).not.toContain("<think>");
    expect(finalText).not.toContain("</think>");
  });

  it("does not pass literal think tags through normal preview body while preserving real thinking block", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-literal-think-preview" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "真实思考", isReasoning: true }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(3000);
    await handle.deliver(
      { text: "正文示例 `<think>不要折叠</think>`", isReasoning: false },
      { kind: "block" },
    );

    const previewText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(previewText).toContain("<think>真实思考</think>");
    expect(previewText).toContain("`&lt;think&gt;不要折叠&lt;/think&gt;`");
    expect(previewText.match(/<think>/g)).toHaveLength(1);
    expect(previewText.match(/<\/think>/g)).toHaveLength(1);
  });

  it("keeps the think block when body preview updates later", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-body-preview" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "先拆解问题", isReasoning: true }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(3000);
    await handle.deliver({ text: "正文预览", isReasoning: false }, { kind: "block" });

    const previewText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(previewText).toContain("<think>先拆解问题</think>");
    expect(previewText).not.toContain("dbg-r");
    expect(previewText).toContain("正文预览");
  });

  it("keeps the body preview when thinking updates later", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-body-preview-then-thinking" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "正文预览", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(3000);
    await handle.deliver({ text: "后续思考", isReasoning: true }, { kind: "block" });

    const previewText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(previewText).toContain("<think>后续思考</think>");
    expect(previewText).not.toContain("dbg-r");
    expect(previewText).toContain("正文预览");
  });

  it("extracts later inline think blocks from ordinary block text", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-inline-think-block" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "第一段正文", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(3000);
    await handle.deliver(
      { text: "<think>第二轮思考</think>\n第二段正文", isReasoning: false },
      { kind: "block" },
    );

    const previewText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(previewText).toContain("<think>第二轮思考</think>");
    expect(previewText).toContain("第一段正文");
    expect(previewText).toContain("第二段正文");
    expect(previewText).not.toContain("&lt;think&gt;第二轮思考");
    expect(previewText.match(/<think>/g)).toHaveLength(1);
    expect(previewText.match(/<\/think>/g)).toHaveLength(1);
  });

  it("extracts inline think blocks from final text without leaking them into final body", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-inline-think-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "正文预览", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(3000);
    await handle.deliver(
      { text: "<think>最终前思考</think>\n最终正文", isReasoning: false },
      { kind: "final" },
    );

    const progressText = String(mockClient.replyStream.mock.calls.at(-2)?.[2] ?? "");
    const finalText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(progressText).toContain("<think>最终前思考</think>");
    expect(finalText).toContain("正文预览");
    expect(finalText).toContain("最终正文");
    expect(finalText).not.toContain("<think>");
    expect(finalText).not.toContain("最终前思考");
  });

  it("keeps literal think tags inside code as normal body text", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-inline-think-code" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      { text: "正文示例 `<think>不要折叠</think>`", isReasoning: false },
      { kind: "block" },
    );

    const previewText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(previewText).toContain("`&lt;think&gt;不要折叠&lt;/think&gt;`");
    expect(previewText).not.toContain("<think>不要折叠</think>");
  });

  it("puts the think block only on the first long final chunk", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-long-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const longText = `${"正文很长。".repeat(1500)}END-THINK-B2`;

    await handle.deliver({ text: "这是思考过程", isReasoning: true }, { kind: "block" });
    const deliverPromise = handle.deliver({ text: longText, isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    await deliverPromise;

    const firstChunk = String(mockClient.replyStream.mock.calls[1]?.[2] ?? "");
    const pushedText = mockClient.sendMessage.mock.calls
      .map((call) => String((call[1] as any).markdown.content))
      .join("\n");
    expect(firstChunk).not.toContain("<think>");
    expect(firstChunk).not.toContain("这是思考过程");
    expect(firstChunk).toContain("第1/");
    expect(firstChunk).not.toContain("消息过长");
    expect(pushedText).toContain("END-THINK-B2");
    expect(pushedText).not.toContain("<think>");
  });

  it("does not show chunk markers in thinking previews before the final text is complete", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-preview-no-chunk-marker" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "思考过程。".repeat(900), isReasoning: true }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(3_000);
    await handle.deliver({ text: "正文预览。".repeat(700), isReasoning: false }, { kind: "block" });

    const previewText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(previewText).toContain("<think>");
    expect(previewText).toContain("正文预览。");
    expect(previewText).not.toContain("【第");
    expect(previewText).not.toContain("消息过长");
  });

  it("keeps enough body room when thinking preview is long", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-long-thinking-body-room" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "思考内容。".repeat(900), isReasoning: true }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(3_000);
    await handle.deliver({ text: `${"正文内容。".repeat(480)}BODY-PREVIEW-END`, isReasoning: false }, { kind: "block" });

    const previewText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(previewText).toContain("<think>");
    expect(previewText).toContain("正文内容。".repeat(120));
    expect(previewText).not.toContain("【第");
  });

  it("closes reasoning-only streams with a completion marker", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-only-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "只有思考过程", isReasoning: true }, { kind: "block" });
    await handle.deliver({ text: "", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    const finalText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalText).not.toContain("<think>");
    expect(finalText).not.toContain("只有思考过程");
    expect(finalText).toContain(FINAL_COMPLETION_MARKER);
    expect(mockClient.replyStream.mock.calls.at(-1)?.[3]).toBe(true);
  });

  it("freezes long block previews and keeps updating only the status line", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-preview-freeze" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const longBlock = `${"预览内容。".repeat(700)}END-FROZEN`;

    await handle.deliver({ text: longBlock, isReasoning: false }, { kind: "block" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    const firstPreview = String(mockClient.replyStream.mock.calls[0]?.[2] ?? "");
    expect(firstPreview).toContain("预览内容。");
    expect(firstPreview).not.toContain("END-FROZEN");
    expect(firstPreview).toContain("执行长任务中，当前用时1s");

    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    const secondPreview = String(mockClient.replyStream.mock.calls[1]?.[2] ?? "");
    expect(secondPreview).toContain("预览内容。");
    expect(secondPreview).toContain("执行长任务中，当前用时15s");
    expect(secondPreview).not.toContain("END-FROZEN");
  });

  it("anchors frozen preview elapsed time to task start and keeps it advancing", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-preview-task-clock" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    // Tool/reasoning work can run for a while before the first visible block.
    // The progress clock must not restart when that block freezes the preview.
    await vi.advanceTimersByTimeAsync(65_000);
    const longBlock = "预览内容。".repeat(700);
    await handle.deliver({ text: longBlock, isReasoning: false }, { kind: "block" });

    const statusContents = () =>
      mockClient.replyStream.mock.calls.map((call) => String(call[2] ?? ""));
    expect(statusContents().at(-1)).toContain("执行长任务中，当前用时1m05s");
    expect(statusContents().at(-1)).not.toContain("当前用时0s");

    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    expect(statusContents().at(-1)).toContain("执行长任务中，当前用时1m20s");

    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    expect(statusContents().at(-1)).toContain("执行长任务中，当前用时1m35s");
  });

  it("freezes short block previews by elapsed time and keeps the original text visible", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-preview-time-freeze" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "正在查询数据源", isReasoning: false }, { kind: "block" });
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-preview-time-freeze" } }),
      expect.any(String),
      "正在查询数据源",
      false,
    );

    await vi.advanceTimersByTimeAsync(300_000);
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-preview-time-freeze" } }),
      expect.any(String),
      "正在查询数据源\n\n执行长任务中，当前用时5m00s",
      false,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(3);
    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-preview-time-freeze" } }),
      expect.any(String),
      "正在查询数据源\n\n执行长任务中，当前用时5m15s",
      false,
    );
  });

  it("stops frozen preview status updates after the final reply", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-preview-final-stop" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const longBlock = "预览内容。".repeat(620);

    await handle.deliver({ text: longBlock, isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);

    const deliverPromise = handle.deliver({ text: "最终正文", isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    await deliverPromise;
    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-preview-final-stop" } }),
      expect.any(String),
      expect.stringContaining("第1/"),
      true,
    );
    const delivered = [
      String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? ""),
      ...mockClient.sendMessage.mock.calls.map((call) => String((call[1] as any).markdown.content)),
    ].join("\n");
    expect(delivered).toContain("最终正文");
    expect(delivered).toContain(FINAL_COMPLETION_MARKER);

    await vi.advanceTimersByTimeAsync(45_000);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(3);
  });

  it("falls back to the full final text if the frozen preview was not delivered", async () => {
    const previewError = new Error("temporary preview failure");
    const expiredError = {
      headers: { req_id: "req-undelivered-preview-final" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockRejectedValueOnce(previewError);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const prefix = Array.from({ length: 420 }, (_, index) =>
      `预览内容${String(index).padStart(3, "0")}。`,
    ).join("");
    const final = `${prefix}\n\n后续最终内容`;

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-undelivered-preview-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: prefix, isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: final, isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toContain("预览内容000。");
    expect(pushed).toContain("后续最终内容");
    expect(pushed).toContain(FINAL_COMPLETION_MARKER);
    expect(pushed).not.toContain("继续输出：");
  });

  it("does not leak think blocks into active push when stream final falls back", async () => {
    const expiredError = {
      headers: { req_id: "req-thinking-stream-fallback" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-stream-fallback" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "思考过程", isReasoning: true }, { kind: "block" });
    await handle.deliver({ text: "最终正文", isReasoning: false }, { kind: "final" });

    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toContain("最终正文");
    expect(pushed).toContain(FINAL_COMPLETION_MARKER);
    expect(pushed).not.toContain("<think>");
    expect(pushed).not.toContain("dbg-r");
  });

  it("continues with OpenClaw's LLM failure final after an expired visible preview", async () => {
    const expiredError = {
      headers: { req_id: "req-openclaw-llm-failed-final" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-openclaw-llm-failed-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "已完成前置工具调用", isReasoning: false }, { kind: "block" });
    await handle.deliver(
      { text: "LLM request failed.", isReasoning: false, isError: true },
      { kind: "final" },
    );

    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toBe("任务未完成：\n\nLLM request failed.");
    expect(pushed).not.toContain(FINAL_COMPLETION_MARKER);
    expect(pushed).not.toContain("WeCom WS reply failed");
  });

  it.each([
    [
      "generic-run-failure",
      "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
    ],
    ["llm-timeout-final", "LLM request timed out."],
  ])("does not mark OpenClaw error final %s as completed", async (caseId, errorText) => {
    const expiredError = {
      headers: { req_id: `req-${caseId}` },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(expiredError);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: `req-${caseId}` },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "长任务已完成若干步骤", isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: errorText, isError: true }, { kind: "final" });

    const pushed = String((mockClient.sendMessage.mock.calls.at(-1)?.[1] as any).markdown.content);
    expect(pushed).toBe(`任务未完成：\n\n${errorText}`);
    expect(pushed).not.toContain(FINAL_COMPLETION_MARKER);
  });

  it("keeps a model timeout distinct from a WeCom delivery interruption after the stream expires", async () => {
    const expiredError = {
      headers: { req_id: "req-idle-timeout-after-reasoning" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(expiredError);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-idle-timeout-after-reasoning" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "正在分析导出步骤", isReasoning: true }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(3_000);
    await handle.deliver({ text: "继续检查下载链路", isReasoning: true }, { kind: "block" });
    await handle.fail(new Error("LLM idle timeout (120s): no response from model"));

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.sendMessage).toHaveBeenLastCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: "⚠️ 模型响应超时，本次任务未完成，请稍后重试。" },
    });
  });

  it("recognizes OpenClaw's prompt-timeout wording as a model timeout", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-prompt-timeout-notice" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.fail?.(new Error("Request timed out before a response was generated."));

    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-prompt-timeout-notice" } }),
      expect.any(String),
      "⚠️ 模型响应超时，本次任务未完成，请稍后重试。",
      true,
    );
  });

  it("recognizes a wrapped OpenClaw turn-idle timeout", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-wrapped-turn-timeout" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const cause = new Error("codex app-server turn idle timed out waiting for turn/completed");

    await handle.fail?.(new Error("Operation aborted", { cause }));

    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-wrapped-turn-timeout" } }),
      expect.any(String),
      "⚠️ 模型响应超时，本次任务未完成，请稍后重试。",
      true,
    );
  });

  it("reports prepare timeout without leaking an internal WeCom WS error", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-prepare-timeout-friendly" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const error = new Error("WeCom inbound session prepare timed out after 60000ms");
    error.name = "WeComPrepareTimeoutError";

    await handle.fail?.(error);

    const content = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(content).toBe("⚠️ 会话准备超时，本条消息尚未开始处理，请稍后重新发送。");
    expect(content).not.toContain("WeCom WS reply failed");
  });

  it("closes the stream bubble with the first final chunk and actively sends long remainders", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-long-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const longText = `${"长内容。".repeat(1800)}END-B2`;

    const deliverPromise = handle.deliver({ text: longText, isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    await deliverPromise;

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-long-final" } }),
      expect.any(String),
      expect.stringContaining("第1/"),
      true,
    );
    expect(mockClient.sendMessage).toHaveBeenCalled();
    const firstChunk = String(mockClient.replyStream.mock.calls[0]?.[2] ?? "");
    expect(firstChunk).toContain("【第1/");
    expect(firstChunk).not.toContain("消息过长");
    const pushedText = mockClient.sendMessage.mock.calls
      .map((call) => (call[1] as any).markdown.content)
      .join("\n");
    expect(pushedText).toContain("END-B2");
    expect(pushedText).toMatch(/【第\d+\/\d+段】\n\n（回复完毕）$/);
  });

  it("splits medium Chinese final text before the WeCom stream bubble truncates it", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-medium-final-split" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const finalText = `${"这是一段中文长回复，用于验证企业微信 stream 气泡不会只显示首段。".repeat(140)}TAIL-MEDIUM-B2`;

    const deliverPromise = handle.deliver({ text: finalText, isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    await deliverPromise;

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    const firstChunk = String(mockClient.replyStream.mock.calls[0]?.[2] ?? "");
    expect(firstChunk).toContain("第1/");
    expect(firstChunk).not.toContain("消息过长");
    expect(firstChunk).not.toContain("TAIL-MEDIUM-B2");
    const pushedText = mockClient.sendMessage.mock.calls
      .map((call) => String((call[1] as any).markdown.content))
      .join("\n");
    expect(pushedText).toContain("TAIL-MEDIUM-B2");
    expect(pushedText).toMatch(/【第\d+\/\d+段】\n\n（回复完毕）$/);
  });

  it("keeps repeated large business blocks without an explicit structured restart", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-long-final-dedup" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const repeatedBlock = Array.from({ length: 70 }, (_, index) =>
      `重复观察${String(index).padStart(2, "0")}：这是同一段长任务过程输出，用来模拟 final 里重复带回的内容。`,
    ).join("\n");
    const finalText = `开头说明\n\n${repeatedBlock}\n\n中间过渡\n\n${repeatedBlock}\n\n结尾结论`;

    const deliverPromise = handle.deliver({ text: finalText, isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    await deliverPromise;

    const delivered = [
      String(mockClient.replyStream.mock.calls[0]?.[2] ?? ""),
      ...mockClient.sendMessage.mock.calls.map((call) => String((call[1] as any).markdown.content)),
    ].join("\n");
    expect(delivered).toContain("开头说明");
    expect(delivered).toContain("中间过渡");
    expect(delivered).toContain("结尾结论");
    expect(delivered.match(/重复观察00/g)?.length).toBe(2);
  });

  it("keeps an identical business paragraph when it belongs to different chapters", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-long-final-cross-chapter-paragraph" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const businessParagraph = [
      "共享业务原则：",
      `适用范围：${"该规则在本章承担独立业务含义。".repeat(12)}`,
      `审批要求：${"相同规则在不同章节仍需完整陈述。".repeat(12)}`,
      `履约要求：${"本行属于连续业务段落且必须保留。".repeat(12)}`,
      `审计要求：${"不能仅因多行内容完全一致而删除。".repeat(12)}`,
    ].join("\n");
    const filler = Array.from(
      { length: 55 },
      (_, index) => `章节间明细${String(index).padStart(2, "0")}：用于构造长正文。`,
    ).join("\n");
    const finalText = [
      "# 第一章 供应规则",
      businessParagraph,
      filler,
      "# 第二章 履约规则",
      businessParagraph,
      "第二章独有结论：保留本章完整语义。",
    ].join("\n\n");

    const delivery = handle.deliver({ text: finalText, isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    await delivery;

    const delivered = [
      String(mockClient.replyStream.mock.calls[0]?.[2] ?? ""),
      ...mockClient.sendMessage.mock.calls.map((call) => String((call[1] as any).markdown.content)),
    ].join("\n");
    expect(delivered.match(/共享业务原则/g)?.length).toBe(2);
    expect(delivered).toContain("第二章独有结论");
  });

  it("does not append a short final again when it already exists at the end of preview text", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-short-final-tail-dedup" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const finalText = [
      "自检完了，结论很明确：",
      "",
      "WeCom 插件侧 reasoningPreviewEnabled: true，已打开，不是断点。",
      "",
      "| 层 | 状态 | 证据 |",
      "|---|---|---|",
      "| 1. it-server 到 GLM-5.2 | OK | 实测返回 reasoning_content |",
      "| 2. OpenClaw transport | OK | 会 emit thinking_delta |",
      "",
      "你要不要现在清净地再试一次？发一个问题后别连续追加，给 GLM-5.2 足够时间把 reasoning stream 完整输出。",
    ].join("\n");
    const previewText = [
      "好，我直接查 reasoningPreviewEnabled 在 wecom 插件源码里的取值逻辑和当前配置。",
      "变量名被 minify 了，我直接搜更广的范围。",
      finalText,
    ].join("\n");

    await handle.deliver({ text: "读取源码上下文", isReasoning: true }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(3_000);
    await handle.deliver({ text: previewText, isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: finalText, isReasoning: false }, { kind: "final" });

    const delivered = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(delivered.match(/自检完了，结论很明确/g)?.length).toBe(1);
    expect(delivered.match(/reasoningPreviewEnabled: true/g)?.length).toBe(1);
    expect(delivered).toContain("变量名被 minify 了");
    expect(delivered).toContain("GLM-5.2 足够时间");
    expect(delivered).not.toContain("<think>");
  });

  it("deduplicates repeated structured tails that restart from the same report heading", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-long-final-heading-tail-dedup" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const firstReport = [
      "今日活跃企微会话与定时任务汇总（2026-06-26 12:44）",
      "",
      "采集口径：",
      "· 技能：SKILLS-COMMON-SYSTEM-SESSION-STATUS",
      "· 今日活跃 Session：16 个，涉及 7 个 Agent",
      "",
      "一、今日活跃企微会话概览",
      "",
      "共 16 个活跃会话：",
      "· main：1 个",
      "· knowledge：5 个",
      "",
      "| 用户 | 最后活跃 | 交流主题 |",
      "|---|---:|---|",
      "| 林昱 | 12:43 | 系统配置/运维排查 |",
      "| yaz | 12:34 | x912提供掌纹识别么R20K-2支持MD-06么？ |",
      "",
      "二、定时任务概览",
      "",
      "共 35 个任务，当前连续失败 1 个。",
      "",
      "| 任务名 | 模型 | LC | 上次执行 | 成功率 | 修复状态 |",
      "|---|---|---|---|---:|---|",
      "| 安全审查-全天（全团队） | it-server/gpt-5.5 | 默认 | 成功 | - |  |",
      "| 每日AI日报-产品部（独立链路） | it-server/gpt-5.5 | 默认 | 失败 | - | 修复后仍失败 |",
      "",
      "三、异常与观察项",
      "",
      "· 当前连续失败：1 个",
      "· 建议：可把该 cron 主模型临时切到 it-server/claude-opus-4-8，或增加延迟重试/错峰重跑策略。",
    ].join("\n");
    const secondReport = firstReport;
    const filler = Array.from({ length: 70 }, (_, index) =>
      `补充明细${String(index).padStart(2, "0")}：这是一段用于模拟长报告正文的内容，保证 final 触发长文本去重。`,
    ).join("\n");
    const uniqueTail = "唯一后续结论：这段内容只出现在重复报告之后，不能被结构化去重误删。";
    const finalText = `${firstReport}\n\n${filler}\n\n${secondReport}\n\n${uniqueTail}`;

    const deliverPromise = handle.deliver({ text: finalText, isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    await deliverPromise;

    const delivered = [
      String(mockClient.replyStream.mock.calls[0]?.[2] ?? ""),
      ...mockClient.sendMessage.mock.calls.map((call) => String((call[1] as any).markdown.content)),
    ].join("\n");
    expect(delivered).toContain("三、异常与观察项");
    expect(delivered).toContain("补充明细69");
    expect(delivered).toContain(uniqueTail);
    expect(delivered.match(/今日活跃企微会话与定时任务汇总/g)?.length).toBe(1);
  });

  it("keeps a reordered structured section instead of treating shared lines as a duplicate", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-long-final-reordered-structure" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const heading = "系统运行状态与任务处理结果汇总报告";
    const first = [
      heading,
      "一、总体结论",
      "甲项：主链路运行正常。",
      "乙项：备用链路等待复核。",
      "二、详细项目",
      "丙项：附件投递通过。",
      "丁项：长任务投递通过。",
    ].join("\n");
    const reordered = [
      heading,
      "一、总体结论",
      "乙项：备用链路等待复核。",
      "甲项：主链路运行正常。",
      "二、详细项目",
      "丙项：附件投递通过。",
      "唯一后文：本段顺序变化具有业务含义，不能删除。",
    ].join("\n");
    const filler = Array.from({ length: 80 }, (_, index) =>
      `运行明细${String(index).padStart(2, "0")}：用于构造足够长的结构化报告正文。`,
    ).join("\n");

    const delivery = handle.deliver(
      { text: `${first}\n${filler}\n${reordered}` },
      { kind: "final" },
    );
    await drainChunkTimers();
    await delivery;
    const delivered = [
      String(mockClient.replyStream.mock.calls[0]?.[2] ?? ""),
      ...mockClient.sendMessage.mock.calls.map((call) => String((call[1] as any).markdown.content)),
    ].join("\n");
    expect(delivered.match(new RegExp(heading, "g"))?.length).toBe(2);
    expect(delivered).toContain("唯一后文");
  });

  it("does not deduplicate repeated markdown table blocks", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-long-final-table-dedup" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const table = [
      "| 项目 | 状态 | 说明 |",
      "| --- | --- | --- |",
      ...Array.from({ length: 80 }, (_, index) =>
        `| 任务${String(index).padStart(2, "0")} | OK | 表格行需要保留，避免误删 B1 表格内容 |`,
      ),
    ].join("\n");
    const finalText = `表格一\n\n${table}\n\n表格二\n\n${table}\n\n收尾`;

    const deliverPromise = handle.deliver({ text: finalText, isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    await deliverPromise;

    const delivered = [
      String(mockClient.replyStream.mock.calls[0]?.[2] ?? ""),
      ...mockClient.sendMessage.mock.calls.map((call) => String((call[1] as any).markdown.content)),
    ].join("\n");
    expect(delivered.match(/任务00/g)?.length).toBe(2);
  });

  it("streams text preview while media is deferred to final", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-block-media" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      {
        text: "正文先发",
        mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
        isReasoning: false,
      },
      { kind: "block" },
    );

    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-block-media" } }),
      expect.any(String),
      "正文先发",
      false,
    );
  });

  it("includes default global media local roots for final media sends", async () => {
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: {
        loadConfig: () => ({}),
      },
    } as any);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-final-media-roots" },
        body: {
          from: { userid: "hidao" },
          chattype: "single",
        },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      {
        mediaUrls: ["/Users/YanHaidao/Downloads/01.png"],
        isReasoning: false,
      },
      { kind: "final" },
    );

    expect(uploadAndSendBotWsMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "hidao",
        maxBytes: 80 * 1024 * 1024,
        mediaUrl: "/Users/YanHaidao/Downloads/01.png",
        mediaLocalRoots: expect.arrayContaining([
          path.resolve(resolvePreferredOpenClawTmpDir()),
          "/tmp/wecom-reply-state",
          "/tmp/wecom-reply-state/media",
          path.resolve(os.homedir(), "Desktop"),
          path.resolve(os.homedir(), "Documents"),
          path.resolve(os.homedir(), "Downloads"),
        ]),
      }),
    );
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-final-media-roots" } }),
      expect.any(String),
      "文件已发送。",
      true,
    );
  });

  it("claims a media final before sending so a duplicate callback cannot resend attachments", async () => {
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: {
        loadConfig: () => ({}),
      },
    } as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-duplicate-final-media" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const payload = {
      text: "附件说明",
      mediaUrls: ["/tmp/report.pdf"],
      isReasoning: false,
    };

    await handle.deliver(payload, { kind: "final" });
    await handle.deliver(payload, { kind: "final" });

    expect(uploadAndSendBotWsMediaMock).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
  });

  it("stops a media final after supersede makes the first attachment visible", async () => {
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: {
        loadConfig: () => ({}),
      },
    } as any);
    let releaseMedia!: () => void;
    uploadAndSendBotWsMediaMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseMedia = () => resolve({ ok: true, messageId: "media-visible" });
        }),
    );
    const onDeliver = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-supersede-during-final-media" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onDeliver,
    });
    const delivery = handle.deliver(
      {
        text: "旧任务附件说明",
        mediaUrls: ["/tmp/first.pdf", "/tmp/second.pdf"],
        isReasoning: false,
      },
      { kind: "final" },
    );
    await flushPromises();

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    releaseMedia();
    await delivery;
    await flushPromises();

    expect(uploadAndSendBotWsMediaMock).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-supersede-during-final-media" } }),
      expect.any(String),
      expect.stringContaining("已收到新消息"),
      true,
    );
    expect(onDeliver).toHaveBeenCalledTimes(1);
  });

  it("never reclaims successful final media while text fallback retries are exhausted", async () => {
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: {
        loadConfig: () => ({}),
      },
    } as any);
    const expiredError = {
      headers: { req_id: "req-media-text-retry-exhausted" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    mockClient.sendMessage.mockRejectedValue(new Error("active push rejected before delivery"));
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-text-retry-exhausted" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const payload = {
      text: "附件说明",
      mediaUrls: ["/tmp/report.pdf"],
      isReasoning: false,
    };

    await handle.deliver(payload, { kind: "final" });
    await vi.advanceTimersByTimeAsync(140_000);
    await flushPromises();
    await handle.deliver(payload, { kind: "final" });

    expect(uploadAndSendBotWsMediaMock).toHaveBeenCalledTimes(1);
    // 4 text delivery attempts plus the one-time exhaustion failure notice.
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(5);
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
  });

  it("preserves the final claim when a visible long first chunk outlives remainder retries", async () => {
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: {
        loadConfig: () => ({}),
      },
    } as any);
    mockClient.sendMessage.mockRejectedValue(new Error("remainder rejected before delivery"));
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-long-media-retry-exhausted" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const payload = {
      text: `${"长任务正文。".repeat(1_600)}LONG-MEDIA-TAIL`,
      mediaUrls: ["/tmp/report.pdf"],
      isReasoning: false,
    };

    const firstDelivery = handle.deliver(payload, { kind: "final" });
    await vi.advanceTimersByTimeAsync(800);
    await firstDelivery;
    await vi.advanceTimersByTimeAsync(140_000);
    await flushPromises();
    await handle.deliver(payload, { kind: "final" });

    expect(uploadAndSendBotWsMediaMock).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    // 4 remainder delivery attempts plus the one-time exhaustion notice.
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(5);
  });

  it("does not claim a media final before configuration is resolved", async () => {
    const runtime = await import("../../runtime.js");
    const configError = new Error("config unavailable");
    const loadConfig = vi.fn().mockImplementationOnce(() => {
      throw configError;
    }).mockReturnValue({});
    runtime.setWecomRuntime({ config: { loadConfig } } as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-config-recovery" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const payload = {
      text: "附件说明",
      mediaUrls: ["/tmp/report.pdf"],
      isReasoning: false,
    };

    await expect(handle.deliver(payload, { kind: "final" })).rejects.toBe(configError);
    await expect(handle.deliver(payload, { kind: "final" })).resolves.toBeUndefined();

    expect(uploadAndSendBotWsMediaMock).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
  });

  it("passes configured mediaMaxMb to final media sends", async () => {
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: {
        loadConfig: () => ({
          agents: {
            defaults: {
              mediaMaxMb: 12,
            },
          },
          channels: {
            wecom: {
              mediaMaxMb: 24,
              accounts: {
                default: {
                  mediaMaxMb: 40,
                },
              },
            },
          },
        }),
      },
    } as any);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-final-media-max-bytes" },
        body: {
          from: { userid: "hidao" },
          chattype: "single",
        },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      {
        mediaUrls: ["/Users/YanHaidao/Downloads/01.png"],
        isReasoning: false,
      },
      { kind: "final" },
    );

    expect(uploadAndSendBotWsMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "hidao",
        maxBytes: 40 * 1024 * 1024,
      }),
    );
  });

  it("stops placeholder keepalive after a visible block preview", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-placeholder-media" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });

    vi.advanceTimersByTime(3000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    await handle.deliver(
      {
        text: "正文先发",
        mediaUrls: ["/tmp/a.png"],
        isReasoning: false,
      },
      { kind: "block" },
    );

    vi.advanceTimersByTime(6000);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);

    await handle.deliver({ text: "最终正文", isReasoning: false }, { kind: "final" });
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-placeholder-media" } }),
      expect.any(String),
      "正文先发\n最终正文",
      true,
    );

    vi.advanceTimersByTime(6000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(3);
  });

  it("actively pushes the final reply when the original stream window has expired", async () => {
    const expiredError = {
      headers: { req_id: "req-expired" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const onFail = vi.fn();

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-expired" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });

    await handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).toHaveBeenCalledWith("unknown", {
      msgtype: "markdown",
      markdown: { content: `最终回复\n\n${FINAL_COMPLETION_MARKER}` },
    });
    expect(onFail).not.toHaveBeenCalled();
  });

  it("keeps long tasks alive when status preview updates expire before final delivery", async () => {
    const expiredError = {
      headers: { req_id: "req-long-task-status-expired" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const onFail = vi.fn();

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-long-task-status-expired" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });

    await handle.deliver({ text: "预览内容。".repeat(620), isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    await handle.deliver({ text: "预览之后继续处理", isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: "最终正文", isReasoning: false }, { kind: "final" });

    expect(onFail).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      markdown: expect.objectContaining({
        content: expect.stringContaining(`最终正文\n\n${FINAL_COMPLETION_MARKER}`),
      }),
    });
  });

  it("keeps long tasks alive when timeout-frozen status updates expire before final delivery", async () => {
    const expiredError = {
      headers: { req_id: "req-long-task-timeout-status-expired" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const onFail = vi.fn();

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-long-task-timeout-status-expired" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });

    await handle.deliver({ text: "正在执行压测", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(300_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    await handle.deliver({ text: "压测结果完成", isReasoning: false }, { kind: "final" });

    expect(onFail).not.toHaveBeenCalled();
    const pushedContents = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    );
    // The final landed well before the 9-minute mark, so the deferred
    // background notice must be skipped instead of promising a follow-up.
    expect(
      pushedContents.some((content) => content.includes("执行长任务中，当前用时")),
    ).toBe(false);
    const finalPush = pushedContents.find((content) => content.includes("压测结果完成"));
    expect(finalPush).toBeDefined();
    expect(finalPush).toContain("继续输出：");
    expect(finalPush).toContain(FINAL_COMPLETION_MARKER);

    // And it stays suppressed after the 9-minute mark: the final settled the
    // stream, so the deferred timer must never fire.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flushPromises();
    expect(
      mockClient.sendMessage.mock.calls.some((call) =>
        String((call[1] as any).markdown.content).includes("执行长任务中，当前用时"),
      ),
    ).toBe(false);
  });

  it("starts the recurring background status when the task is still running at nine minutes", async () => {
    const expiredError = {
      headers: { req_id: "req-nine-minute-notice" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValue(expiredError);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-nine-minute-notice" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "长任务预览", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(300_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();

    // Channel already dead at ~5m15s, but no notice before the 9-minute mark.
    expect(
      mockClient.sendMessage.mock.calls.some((call) =>
        String((call[1] as any).markdown.content).includes("执行长任务中，当前用时"),
      ),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await flushPromises();
    const noticePushes = mockClient.sendMessage.mock.calls.filter((call) =>
      String((call[1] as any).markdown.content).includes("执行长任务中，当前用时"),
    );
    expect(noticePushes).toHaveLength(1);

    // The status keeps advancing once per minute while the task is active.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await flushPromises();
    expect(
      mockClient.sendMessage.mock.calls.filter((call) =>
        String((call[1] as any).markdown.content).includes("执行长任务中，当前用时"),
      ),
    ).toHaveLength(6);
  });

  it("repeats the expired-stream background status every minute until the final arrives", async () => {
    const expiredError = {
      headers: { req_id: "req-recurring-background-status" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValue(expiredError);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-recurring-background-status" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "长任务预览", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(300_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 45_000);
    await flushPromises();

    const backgroundPushes = () =>
      mockClient.sendMessage.mock.calls.filter((call) =>
        String((call[1] as any).markdown.content).includes("执行长任务中，当前用时"),
      );
    expect(backgroundPushes()).toHaveLength(1);
    expect(String((backgroundPushes()[0]?.[1] as any).markdown.content)).toBe(
      "执行长任务中，当前用时9m00s",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(backgroundPushes()).toHaveLength(2);
    expect(String((backgroundPushes()[1]?.[1] as any).markdown.content)).toBe(
      "执行长任务中，当前用时10m00s",
    );

    await handle.deliver({ text: "最终结果", isReasoning: false }, { kind: "final" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await flushPromises();
    expect(backgroundPushes()).toHaveLength(2);
  });

  it("retries the recurring background status one minute after a push failure", async () => {
    const expiredError = {
      headers: { req_id: "req-recurring-status-retry" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValue(expiredError);
    mockClient.sendMessage
      .mockRejectedValueOnce(new Error("status push failed"))
      .mockResolvedValue({} as any);
    const onFail = vi.fn();

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-recurring-status-retry" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });

    await handle.deliver({ text: "长任务预览", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(300_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 45_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(String((mockClient.sendMessage.mock.calls[1]?.[1] as any).markdown.content)).toBe(
      "执行长任务中，当前用时10m00s",
    );
    expect(onFail).not.toHaveBeenCalled();
  });

  it("does not rearm recurring status after external activity while a push is in flight", async () => {
    const expiredError = {
      headers: { req_id: "req-recurring-status-external-activity" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    let releaseStatusPush: (() => void) | undefined;
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValue(expiredError);
    mockClient.sendMessage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStatusPush = resolve;
        }) as any,
    );

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-recurring-status-external-activity" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "长任务预览", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(300_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 45_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    handle.markExternalActivity?.();
    releaseStatusPush?.();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await flushPromises();

    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("drops the deferred background notice when a new message supersedes the task", async () => {
    const expiredError = {
      headers: { req_id: "req-nine-minute-superseded" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValue(expiredError);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-nine-minute-superseded" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "长任务预览", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(300_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await flushPromises();

    expect(
      mockClient.sendMessage.mock.calls.some((call) =>
        String((call[1] as any).markdown.content).includes("执行长任务中，当前用时"),
      ),
    ).toBe(false);
  });

  it("pushes only the continuation when a frozen preview stream has expired", async () => {
    const expiredError = {
      headers: { req_id: "req-expired-after-preview" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const prefix = Array.from({ length: 420 }, (_, index) =>
      `预览内容${String(index).padStart(3, "0")}。`,
    ).join("");
    const final = `${prefix}\n\n后续最终内容`;

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-expired-after-preview" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: prefix, isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: final, isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toContain("继续输出：");
    expect(pushed).toContain("后续最终内容");
    expect(pushed).not.toContain("预览内容000。");
    expect(pushed).toContain("预览内容390。");
  });

  it("pushes only the continuation after a late preview success", async () => {
    let releasePreview: ((value: unknown) => void) | undefined;
    const expiredError = {
      headers: { req_id: "req-preview-late-success-final-expired" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releasePreview = resolve;
          }) as any,
      )
      .mockRejectedValueOnce(expiredError);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-preview-late-success-final-expired" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const prefix = "收到，继续补测 Q2。";
    const previewDelivery = handle.deliver(
      { text: prefix, isReasoning: false },
      { kind: "block" },
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await previewDelivery;
    releasePreview?.({});
    await flushPromises();
    await handle.deliver(
      { text: `${prefix}\n最终结论。`, isReasoning: false },
      { kind: "final" },
    );

    expect(mockClient.replyStream).toHaveBeenCalled();
    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toContain("继续输出：");
    expect(pushed).toContain("最终结论");
    expect(pushed).not.toContain(prefix);
  });

  it("recomputes the continuation when a late preview ACK clears during the final wait", async () => {
    let releasePreview: ((value: unknown) => void) | undefined;
    let pendingAck = false;
    const pendingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
    };
    pendingClient.hasPendingReplyAck = vi.fn(() => pendingAck);
    mockClient.replyStream.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePreview = resolve;
        }) as any,
    );
    const handle = createBotWsReplyHandle({
      client: pendingClient,
      frame: {
        headers: { req_id: "req-late-preview-during-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const previewText = "已经确认展示的开头";
    const previewDelivery = handle.deliver(
      { text: previewText, isReasoning: false },
      { kind: "block" },
    );
    pendingAck = true;
    await vi.advanceTimersByTimeAsync(8_000);
    await previewDelivery;

    const finalDelivery = handle.deliver(
      { text: `${previewText}\n唯一后文`, isReasoning: false },
      { kind: "final" },
    );
    await flushPromises();
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
    releasePreview?.({});
    await flushPromises();
    pendingAck = false;
    await vi.advanceTimersByTimeAsync(100);
    await finalDelivery;

    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).not.toContain(previewText);
    expect(pushed).toContain("唯一后文");
    expect(pushed).toContain("继续输出：");
  });

  it("records an in-flight pending preview that succeeds after final settlement", async () => {
    let releasePreview: ((value: unknown) => void) | undefined;
    let pendingAck = true;
    const expiredError = {
      headers: { req_id: "req-pending-flush-final-expired" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    const pendingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    pendingClient.hasPendingReplyAck = vi.fn(() => pendingAck);
    pendingClient.replyStreamNonBlocking = vi.fn(
      () =>
        new Promise((resolve) => {
          releasePreview = resolve;
        }),
    );
    mockClient.replyStream.mockRejectedValueOnce(expiredError);

    const handle = createBotWsReplyHandle({
      client: pendingClient,
      frame: {
        headers: { req_id: "req-pending-flush-final-expired" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const previewText = "已经确认展示的开头";
    await handle.deliver({ text: previewText, isReasoning: false }, { kind: "block" });
    expect(pendingClient.replyStreamNonBlocking).not.toHaveBeenCalled();

    pendingAck = false;
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    expect(pendingClient.replyStreamNonBlocking).toHaveBeenCalledTimes(1);

    const finalDelivery = handle.deliver(
      { text: `${previewText}\n唯一后文`, isReasoning: false },
      { kind: "final" },
    );
    await flushPromises();
    expect(mockClient.replyStream).not.toHaveBeenCalled();

    releasePreview?.({});
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await finalDelivery;

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toContain("继续输出：");
    expect(pushed).toContain("唯一后文");
    expect(pushed).not.toContain(previewText);
  });

  it("actively pushes the continuation when a visible short preview update hangs", async () => {
    let releaseSecondPreview: (() => void) | undefined;
    mockClient.replyStream
      .mockResolvedValueOnce({} as any)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecondPreview = () => resolve({} as any);
          }) as any,
      );

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-short-preview-hang" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "已经显示的前半段", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(1_500);
    const secondPreview = handle.deliver(
      { text: "已经显示的前半段 后续预览", isReasoning: false },
      { kind: "block" },
    );

    await vi.advanceTimersByTimeAsync(8_000);
    await secondPreview;
    await handle.deliver(
      { text: "已经显示的前半段 后续预览 最终结论", isReasoning: false },
      { kind: "final" },
    );

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      markdown: expect.objectContaining({
        content: expect.stringContaining("继续输出："),
      }),
    });
    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toContain("后续预览 最终结论");
    expect(pushed).not.toContain("已经显示的前半段");
    expect(pushed).toContain(FINAL_COMPLETION_MARKER);

    releaseSecondPreview?.();
  });

  it("skips queued preview updates and actively pushes final while a stream ack is pending", async () => {
    const nonBlockingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    let pendingAck = false;
    nonBlockingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({} as any);
    nonBlockingClient.hasPendingReplyAck = vi.fn(() => pendingAck);

    const handle = createBotWsReplyHandle({
      client: nonBlockingClient,
      frame: {
        headers: { req_id: "req-preview-pending-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "已经显示的前半段", isReasoning: false }, { kind: "block" });
    pendingAck = true;
    await vi.advanceTimersByTimeAsync(1_500);
    await handle.deliver(
      { text: "已经显示的前半段\n后续预览", isReasoning: false },
      { kind: "block" },
    );
    const finalDelivery = handle.deliver(
      { text: "已经显示的前半段\n后续预览\n最终结论", isReasoning: false },
      { kind: "final" },
    );
    await vi.advanceTimersByTimeAsync(5_500);
    await finalDelivery;

    expect(nonBlockingClient.replyStreamNonBlocking).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      markdown: expect.objectContaining({
        content: expect.stringContaining("继续输出："),
      }),
    });
    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toContain("后续预览");
    expect(pushed).toContain("最终结论");
    expect(pushed).not.toContain("已经显示的前半段");
    expect(pushed).toContain(FINAL_COMPLETION_MARKER);
  });

  it("uses the normal final stream path if a pending preview ack clears quickly", async () => {
    const nonBlockingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    nonBlockingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({} as any);
    nonBlockingClient.hasPendingReplyAck = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const handle = createBotWsReplyHandle({
      client: nonBlockingClient,
      frame: {
        headers: { req_id: "req-preview-pending-clears" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "已经显示的前半段", isReasoning: false }, { kind: "block" });
    await handle.deliver(
      { text: "已经显示的前半段\n最终结论", isReasoning: false },
      { kind: "final" },
    );

    expect(nonBlockingClient.replyStreamNonBlocking).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-preview-pending-clears" } }),
      expect.any(String),
      "已经显示的前半段\n最终结论",
      true,
    );
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to active push when the final stream update hangs", async () => {
    mockClient.replyStream.mockImplementationOnce(
      () => new Promise(() => undefined) as any,
    );

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-final-hang" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const delivery = handle.deliver({ text: "最终短回复", isReasoning: false }, { kind: "final" });
    await vi.advanceTimersByTimeAsync(8_000);
    await delivery;

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: `最终短回复\n\n${FINAL_COMPLETION_MARKER}` },
    });
  });

  it("skips the old final push when a visible frozen preview is later superseded", async () => {
    const prefix = Array.from({ length: 420 }, (_, index) =>
      `预览内容${String(index).padStart(3, "0")}。`,
    ).join("");
    const final = `${prefix}\n\n后续最终内容`;

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-superseded-after-preview" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: prefix, isReasoning: false }, { kind: "block" });
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await handle.deliver({ text: final, isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("does not actively push a superseded old final after visible text was streaming", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-superseded-after-visible-text" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "旧回复正在逐步输出", isReasoning: false }, { kind: "block" });
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();
    await handle.deliver({ text: "旧回复最终答案", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-superseded-after-visible-text" } }),
      expect.any(String),
      "旧回复正在逐步输出",
      false,
    );
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("reports failure without marking delivery when stream and active push both fail", async () => {
    const expiredError = {
      headers: { req_id: "req-expired-push-fail" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    const pushError = new Error("active push failed");
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    mockClient.sendMessage.mockRejectedValueOnce(pushError);
    const onDeliver = vi.fn();
    const onFail = vi.fn();

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-expired-push-fail" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onDeliver,
      onFail,
    });

    await handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: `最终回复\n\n${FINAL_COMPLETION_MARKER}` },
    });
    expect(onFail).toHaveBeenCalledWith(pushError);
    expect(onDeliver).not.toHaveBeenCalled();

    mockClient.replyStream.mockRejectedValueOnce(expiredError);

    await handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockClient.sendMessage).toHaveBeenLastCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: `最终回复\n\n${FINAL_COMPLETION_MARKER}` },
    });
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onDeliver).toHaveBeenCalledTimes(1);
  });

  it("retries the final active push after a transient push failure", async () => {
    const expiredError = {
      headers: { req_id: "req-final-retry" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    const pushError = new Error("active push failed");
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    mockClient.sendMessage.mockRejectedValueOnce(pushError);
    const onDeliver = vi.fn();
    const onFail = vi.fn();

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-final-retry" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onDeliver,
      onFail,
    });

    await handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });

    expect(onFail).toHaveBeenCalledWith(pushError);
    expect(onDeliver).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();

    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockClient.sendMessage).toHaveBeenLastCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: `最终回复\n\n${FINAL_COMPLETION_MARKER}` },
    });
    expect(onDeliver).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "ack timeout",
      new Error("Reply ack timeout (5000ms) for reqId: aibot_send_msg_active-push"),
    ],
    ["ambiguous failure", new Error("socket closed after active push send")],
    ["SDK cancellation", new Error("Reply aibot_send_msg active push cancelled")],
  ])(
    "retries an active-push %s while keeping the delivery claim",
    async (_label, pushError) => {
      // The push MAY have reached the user, but permanently dropping the
      // answer proved worse in production than a bounded, progress-tracked
      // re-push of the unconfirmed chunks.
      const expiredError = {
        headers: { req_id: "req-active-push-ack-timeout" },
        errcode: 846608,
        errmsg: "stream message update expired (>6 minutes), cannot update",
      };
      const sendMarkdown = vi.fn().mockRejectedValueOnce(pushError).mockResolvedValue(undefined);
      registerBotWsPushHandle("default", {
        isConnected: () => true,
        sendMarkdown,
        replyCommand: vi.fn(),
        sendMedia: vi.fn(),
      });
      mockClient.replyStream.mockRejectedValueOnce(expiredError);
      const onDeliver = vi.fn();
      const onFail = vi.fn();

      const handle = createBotWsReplyHandle({
        client: mockClient,
        frame: {
          headers: { req_id: "req-active-push-ack-timeout" },
          body: { from: { userid: "alice" }, chattype: "single" },
        } as unknown as ReplyHandleParams["frame"],
        accountId: "default",
        inboundKind: "text",
        autoSendPlaceholder: false,
        onDeliver,
        onFail,
      });

      await handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });

      expect(sendMarkdown).toHaveBeenCalledTimes(1);
      expect(mockClient.sendMessage).not.toHaveBeenCalled();
      expect(onDeliver).not.toHaveBeenCalled();
      expect(onFail).toHaveBeenCalledWith(pushError);

      await vi.advanceTimersByTimeAsync(20_000);
      await flushPromises();

      expect(sendMarkdown).toHaveBeenCalledTimes(2);
      expect(onDeliver).toHaveBeenCalledTimes(1);

      // No further pushes once the retry landed.
      await vi.advanceTimersByTimeAsync(400_000);
      await flushPromises();
      expect(sendMarkdown).toHaveBeenCalledTimes(2);
    },
  );

  it("stops final push retries after exhausting attempts", async () => {
    const expiredError = {
      headers: { req_id: "req-final-retry-exhausted" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    mockClient.sendMessage.mockRejectedValue(new Error("push down"));
    const onDeliver = vi.fn();
    const onFail = vi.fn();

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-final-retry-exhausted" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onDeliver,
      onFail,
    });

    await handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(40_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(80_000);
    await flushPromises();
    // 4 delivery attempts plus the one-time exhaustion failure notice.
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(400_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(5);
    expect(onDeliver).not.toHaveBeenCalled();
    expect(onFail).toHaveBeenCalledTimes(2);
  });

  it("drops a pending final push retry when superseded after visible text", async () => {
    const expiredError = {
      headers: { req_id: "req-retry-superseded" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    mockClient.sendMessage.mockRejectedValueOnce(new Error("push down"));

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-retry-superseded" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "已可见的旧内容", isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: "旧任务最终结果", isReasoning: false }, { kind: "final" });
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });

    await vi.advanceTimersByTimeAsync(400_000);
    await flushPromises();
    // The suppressed superseded final must never be re-pushed by the retry chain.
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("skips the old final when superseded during an ack wait that clears within the grace window", async () => {
    let pendingAck = false;
    const nonBlockingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    nonBlockingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({} as any);
    nonBlockingClient.hasPendingReplyAck = vi.fn(() => pendingAck);

    const handle = createBotWsReplyHandle({
      client: nonBlockingClient,
      frame: {
        headers: { req_id: "req-supersede-ack-clears" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "旧任务可见内容", isReasoning: false }, { kind: "block" });
    pendingAck = true;
    const finalDelivery = handle.deliver(
      { text: "旧任务完整结果", isReasoning: false },
      { kind: "final" },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    // The pending ack clears within the 5.5s grace window; the supersede
    // re-check must still stop the old final from finishing the old stream.
    pendingAck = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await finalDelivery;

    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps a wholly invisible superseded final retry across a newer same-peer activation", async () => {
    const pushError = new Error("push down");
    const onDeliver = vi.fn();

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-superseded-retry" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onDeliver,
    });

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();
    mockClient.replyStream.mockClear();
    mockClient.sendMessage.mockClear();
    mockClient.sendMessage.mockRejectedValueOnce(pushError);

    // No old body was ever confirmed visible, so its bounded retry remains
    // responsible for eventually delivering the result.
    await expect(
      handle.deliver({ text: "旧任务合并结果", isReasoning: false }, { kind: "final" }),
    ).rejects.toThrow("push down");
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-superseded-retry-new" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();

    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockClient.sendMessage).toHaveBeenLastCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: "旧任务合并结果" },
    });
    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(onDeliver).toHaveBeenCalledTimes(1);
  });

  it("suppresses the failure notice while a final push retry is pending", async () => {
    const expiredError = {
      headers: { req_id: "req-fail-notice-retry-pending" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    mockClient.sendMessage.mockRejectedValueOnce(new Error("push down"));
    const onFail = vi.fn();

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-fail-notice-retry-pending" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });

    await handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    const terminalError = new Error("Reply ack timeout (5000ms) for reqId: req-fail-notice-retry-pending");
    await handle.fail(terminalError);
    // While a retry is pending, no "投递中断" notice may be pushed.
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    const retried = String((mockClient.sendMessage.mock.calls[1]?.[1] as any).markdown.content);
    expect(retried).toContain("最终回复");
    expect(retried).not.toContain("投递中断");
  });

  it("routes a non-terminal failure through active push after the stream died", async () => {
    const expiredError = {
      headers: { req_id: "req-fail-after-dead-stream" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const onFail = vi.fn();

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-fail-after-dead-stream" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });

    // Freeze by size, then let the 15s status refresh die terminally.
    await handle.deliver({ text: "预览内容。".repeat(620), isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    const replyStreamCalls = mockClient.replyStream.mock.calls.length;

    await handle.fail(new Error("agent run crashed"));

    // The dead stream must not be written again; the user gets a generic
    // one-time notice by active push instead of raw error internals.
    expect(mockClient.replyStream).toHaveBeenCalledTimes(replyStreamCalls);
    const pushedContents = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    );
    const failNotice = pushedContents.find((content) => content.includes("投递中断"));
    expect(failNotice).toBeDefined();
    expect(failNotice).not.toContain("agent run crashed");
    expect(onFail).toHaveBeenCalled();
  });

  it("resumes the final push retry from the first undelivered chunk", async () => {
    const expiredError = {
      headers: { req_id: "req-retry-chunk-resume" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    // Chunk 1 lands, chunk 2 fails transiently, everything else succeeds.
    mockClient.sendMessage
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(new Error("push down"))
      .mockResolvedValue({} as any);

    const partA = `AAA段落${"甲".repeat(2000)}`;
    const partB = `BBB段落${"乙".repeat(2000)}`;
    const partC = `CCC段落${"丙".repeat(2000)}`;
    const finalText = `${partA}\n\n${partB}\n\n${partC}`;

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-retry-chunk-resume" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const finalDelivery = handle.deliver({ text: finalText, isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    await finalDelivery;

    await vi.advanceTimersByTimeAsync(20_000);
    await drainChunkTimers();

    const pushedContents = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    );
    // The already-delivered first chunk must not be re-sent, while the exact
    // failed second chunk is retried without resetting chunk progress.
    expect(pushedContents.filter((content) => content === pushedContents[0]).length).toBe(1);
    expect(pushedContents[2]).toBe(pushedContents[1]);
    expect(pushedContents.join("\n")).toContain("AAA段落");
    expect(pushedContents.join("\n")).toContain("BBB段落");
    expect(pushedContents.join("\n")).toContain("CCC段落");
  });

  it("retries a failed normal-stream remainder without reopening the closed stream", async () => {
    mockClient.sendMessage
      .mockRejectedValueOnce(new Error("remainder push failed"))
      .mockResolvedValue({} as any);
    const onDeliver = vi.fn();
    const finalText = `${"长正文。".repeat(1_600)}TAIL`;
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-normal-remainder-retry" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onDeliver,
    });

    const delivery = handle.deliver(
      { text: finalText, isReasoning: false },
      { kind: "final" },
    );
    await drainChunkTimers();
    await expect(delivery).resolves.toBeUndefined();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    await drainChunkTimers();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    const pushedContents = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    );
    expect(pushedContents[1]).toBe(pushedContents[0]);
    expect(pushedContents.some((content) => content.includes("TAIL"))).toBe(true);
    expect(pushedContents.some((content) => content.includes(FINAL_COMPLETION_MARKER))).toBe(true);
    expect(onDeliver).toHaveBeenCalledOnce();
  });

  it("does not retry an old remainder after a newer peer reply activates", async () => {
    mockClient.sendMessage
      .mockRejectedValueOnce(new Error("remainder push failed"))
      .mockResolvedValue({} as any);
    const oldHandle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-old-remainder-before-new-activation" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const finalText = `${"旧任务。".repeat(1_600)}OLD-TAIL`;

    const oldDelivery = oldHandle.deliver(
      { text: finalText, isReasoning: false },
      { kind: "final" },
    );
    await drainChunkTimers();
    await oldDelivery;
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    const newHandle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-new-remainder-activation" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const newDelivery = newHandle.deliver(
      { text: finalText, isReasoning: false },
      { kind: "final" },
    );
    await drainChunkTimers();
    await newDelivery;
    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    const callsAfterNewFinal = mockClient.sendMessage.mock.calls.length;
    expect(callsAfterNewFinal).toBeGreaterThan(1);

    await vi.advanceTimersByTimeAsync(20_000);
    await drainChunkTimers();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(callsAfterNewFinal);
  });

  it("stops an in-flight remainder retry when a newer peer reply activates", async () => {
    let releaseRetryChunk!: (value: unknown) => void;
    const retryChunk = new Promise((resolve) => {
      releaseRetryChunk = resolve;
    });
    mockClient.sendMessage
      .mockRejectedValueOnce(new Error("remainder push failed"))
      .mockReturnValueOnce(retryChunk as any)
      .mockResolvedValue({} as any);
    const onDeliver = vi.fn();
    const oldHandle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-inflight-old-retry" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onDeliver,
    });

    const oldDelivery = oldHandle.deliver(
      { text: `${"旧任务。".repeat(1_600)}OLD-TAIL`, isReasoning: false },
      { kind: "final" },
    );
    await drainChunkTimers();
    await oldDelivery;
    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);

    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-inflight-new-reply" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    releaseRetryChunk({});
    await flushPromises();
    await drainChunkTimers();

    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(onDeliver).not.toHaveBeenCalled();
  });

  it("does not start old remainders after supersede during the first final chunk", async () => {
    let releaseFirstChunk!: (value: unknown) => void;
    mockClient.replyStream.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirstChunk = resolve;
        }) as any,
    );
    const oldHandle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-first-final-chunk-old" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const oldDelivery = oldHandle.deliver(
      { text: `${"旧任务。".repeat(1_600)}OLD-TAIL`, isReasoning: false },
      { kind: "final" },
    );
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledOnce();

    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-first-final-chunk-new" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    oldHandle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    releaseFirstChunk({});
    await oldDelivery;
    await vi.advanceTimersByTimeAsync(400_000);
    await flushPromises();

    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps a pending retry across many unrelated peer activations", async () => {
    mockClient.sendMessage
      .mockRejectedValueOnce(new Error("remainder push failed"))
      .mockResolvedValue({} as any);
    const oldHandle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: {},
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const oldDelivery = oldHandle.deliver(
      { text: `${"旧任务。".repeat(1_600)}OLD-TAIL`, isReasoning: false },
      { kind: "final" },
    );
    await drainChunkTimers();
    await oldDelivery;
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 2_100; index += 1) {
      createBotWsReplyHandle({
        client: mockClient,
        frame: {
          headers: {},
          body: { from: { userid: `peer-${index}` }, chattype: "single" },
        } as unknown as ReplyHandleParams["frame"],
        accountId: "default",
        inboundKind: "text",
        autoSendPlaceholder: false,
      });
    }

    await vi.advanceTimersByTimeAsync(20_000);
    await drainChunkTimers();
    expect(mockClient.sendMessage.mock.calls.length).toBeGreaterThan(1);
    const pushed = mockClient.sendMessage.mock.calls
      .map((call) => String((call[1] as any).markdown.content))
      .join("\n");
    expect(pushed).toContain("OLD-TAIL");
  });

  it("delivers every long-final chunk after a task runs longer than ten minutes", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-long-task-after-ten-minutes" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const finalText = `${"长任务。".repeat(1_600)}LONG-TAIL`;

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    const delivery = handle.deliver(
      { text: finalText, isReasoning: false },
      { kind: "final" },
    );
    await drainChunkTimers();
    await delivery;

    const delivered = [
      String(mockClient.replyStream.mock.calls[0]?.[2] ?? ""),
      ...mockClient.sendMessage.mock.calls.map((call) =>
        String((call[1] as any).markdown.content),
      ),
    ].join("\n");
    expect(delivered).toContain("LONG-TAIL");
    expect(delivered).toContain(FINAL_COMPLETION_MARKER);
  });

  it("stops the frozen status refresh permanently at the watchdog lifetime cap", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-watchdog-cap" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "预览内容。".repeat(620), isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(30_000);
    await flushPromises();
    const callsBeforeCap = mockClient.replyStream.mock.calls.length;
    expect(callsBeforeCap).toBeGreaterThan(2);

    // Jump wall time to the lifetime cap without executing every 15s refresh.
    vi.setSystemTime(Date.now() + 3_600_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    const callsAtCap = mockClient.replyStream.mock.calls.length;
    expect(callsAtCap).toBe(callsBeforeCap);

    await vi.advanceTimersByTimeAsync(600_000);
    await flushPromises();
    // No further status refreshes once the 60min cap latched, and block
    // events must not re-arm the interval either.
    expect(mockClient.replyStream).toHaveBeenCalledTimes(callsAtCap);
    await handle.deliver({ text: "追加内容", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(callsAtCap);
  });

  it("does not flush the old final into the old stream when superseded during the pending-ack wait", async () => {
    const nonBlockingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    let pendingAck = false;
    nonBlockingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({} as any);
    nonBlockingClient.hasPendingReplyAck = vi.fn(() => pendingAck);

    const handle = createBotWsReplyHandle({
      client: nonBlockingClient,
      frame: {
        headers: { req_id: "req-supersede-during-ack-wait" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "旧任务可见内容", isReasoning: false }, { kind: "block" });
    pendingAck = true;
    const finalDelivery = handle.deliver(
      { text: "旧任务完整结果", isReasoning: false },
      { kind: "final" },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await vi.advanceTimersByTimeAsync(5_500);
    await finalDelivery;

    // The superseded old final must neither finish the old stream bubble nor
    // be pushed, and no retry chain may revive it later.
    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400_000);
    await flushPromises();
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("redirects the final to an active push when superseded during the pending-ack wait without visible text", async () => {
    const nonBlockingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    nonBlockingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({} as any);
    nonBlockingClient.hasPendingReplyAck = vi.fn().mockReturnValue(true);

    const handle = createBotWsReplyHandle({
      client: nonBlockingClient,
      frame: {
        headers: { req_id: "req-supersede-ack-wait-invisible" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const finalDelivery = handle.deliver(
      { text: "旧任务结果", isReasoning: false },
      { kind: "final" },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await finalDelivery;

    // Without visible text the old final still merge-delivers by active push,
    // but never touches the old stream.
    expect(mockClient.replyStream).not.toHaveBeenCalled();
    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toContain("旧任务结果");
  });

  it("does not finish the old stream with an error text after supersede", async () => {
    const onFail = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-fail-superseded" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });

    await handle.deliver({ text: "旧回复可见内容", isReasoning: false }, { kind: "block" });
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    const abortError = new Error(
      "WeCom Bot WS reply aborted: superseded by a newer inbound message.",
    );
    await handle.fail(abortError);

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
    expect(onFail).toHaveBeenCalledWith(abortError);
  });

  it("shows a friendly notice without session internals when initialization still conflicts", async () => {
    const conflict = new Error("OpenClaw dispatch failed", {
      cause: new Error(
        "reply session initialization conflicted for agent:main:wecom:direct:linky",
      ),
    });
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-init-conflict" },
        body: { from: { userid: "linky" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.fail(conflict);

    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "上一轮任务还在处理中或会话状态刚发生变化，这条消息未能处理，请稍后重新发送。",
      true,
    );
    const delivered = String(mockClient.replyStream.mock.calls[0]?.[2] ?? "");
    expect(delivered).not.toContain("WeCom WS reply failed");
    expect(delivered).not.toContain("agent:main:wecom");
  });

  it("actively pushes the friendly conflict notice after the stream channel expires", async () => {
    const expiredError = {
      headers: { req_id: "req-init-conflict-expired" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-init-conflict-expired" },
        body: { from: { userid: "linky" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "预览内容。".repeat(620) }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    await handle.fail(
      new Error(
        "reply session initialization conflicted for agent:main:wecom:direct:linky",
      ),
    );

    const pushed = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    );
    expect(pushed).toContain("上一轮任务还在处理中或会话状态刚发生变化，这条消息未能处理，请稍后重新发送。");
    expect(pushed.join("\n")).not.toContain("agent:main:wecom");
  });

  it("pushes a one-time failure notice when the reply channel died terminally", async () => {
    const onFail = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-fail-terminal-notice" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });

    await handle.deliver({ text: "部分内容", isReasoning: false }, { kind: "block" });
    const terminalError = new Error("Reply ack timeout (5000ms) for reqId: req-fail-terminal-notice");
    await handle.fail(terminalError);

    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toContain("回复投递中断");

    await handle.fail(terminalError);
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledTimes(2);
  });

  it("keeps visible progress and hides no-visible-output internals on failure", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-no-visible-output" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const progress = "已完成前置检查。\n💨Fast: auto-off(62s>=60s)";
    await handle.deliver({ text: progress, isReasoning: false }, { kind: "block" });
    const error = new Error(
      "WeCom Bot WS reply produced no visible output for agent:main:wecom:direct:alice.",
    );
    error.name = "WeComReplyNoVisibleOutputError";

    await handle.fail(error);

    const delivered = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(delivered).toContain("已完成前置检查");
    expect(delivered).toContain("Fast: auto-off");
    expect(delivered).toContain("本次回复投递中断");
    expect(delivered).not.toContain("no visible output");
    expect(delivered).not.toContain("agent:main:wecom");
    expect(delivered.length).toBeLessThanOrEqual(3_500);
    expect(Buffer.byteLength(delivered, "utf8")).toBeLessThanOrEqual(12_000);
  });

  it("uses active push for a no-visible-output failure while the stream ACK stays pending", async () => {
    const nonBlockingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    let pendingAck = false;
    nonBlockingClient.hasPendingReplyAck = vi.fn(() => pendingAck);
    nonBlockingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({});
    const onFail = vi.fn();
    const handle = createBotWsReplyHandle({
      client: nonBlockingClient,
      frame: {
        headers: { req_id: "req-no-visible-pending-ack" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });
    await handle.deliver({ text: "Fast: auto-off(62s>=60s)" }, { kind: "block" });
    pendingAck = true;
    const error = new Error("WeCom Bot WS reply produced no visible output for session-a.");
    error.name = "WeComReplyNoVisibleOutputError";

    const failure = handle.fail?.(error);
    await vi.advanceTimersByTimeAsync(5_600);
    await failure;

    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toContain("本次回复投递中断");
    expect(pushed).not.toContain("no visible output");
    expect(onFail).toHaveBeenCalledWith(error);
  });

  it("starts the frozen status refresh even when the freezing preview send is skipped", async () => {
    const nonBlockingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    nonBlockingClient.replyStreamNonBlocking = vi
      .fn()
      .mockResolvedValueOnce("skipped")
      .mockResolvedValue({} as any);
    nonBlockingClient.hasPendingReplyAck = vi.fn().mockReturnValue(false);

    const handle = createBotWsReplyHandle({
      client: nonBlockingClient,
      frame: {
        headers: { req_id: "req-frozen-skip-selfheal" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "预览内容。".repeat(620), isReasoning: false }, { kind: "block" });
    expect(nonBlockingClient.replyStreamNonBlocking).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();

    // Without the self-healing interval start, the skipped freezing send
    // would leave the status counter dead until the next block event.
    expect(nonBlockingClient.replyStreamNonBlocking.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastCall = nonBlockingClient.replyStreamNonBlocking.mock.calls.at(-1);
    expect(String(lastCall?.[2])).toContain("预览内容");
    expect(String(lastCall?.[2])).toContain("执行长任务中，当前用时");
  });

  it("sends a merge notice when superseded and later pushes the old final without updating the old stream", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-superseded-a" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });

    vi.advanceTimersByTime(3000);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.replyStream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ headers: { req_id: "req-superseded-a" } }),
      expect.any(String),
      "已收到新消息，合并思考。✅",
      true,
    );

    await handle.deliver({ text: "A 的最终答案", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: "A 的最终答案" },
    });
  });

  it("retries an ambiguous final push failure instead of silently losing the answer", async () => {
    const ackTimeout = new Error("Reply ack timeout (5000ms) for reqId: req-ambiguous-final");
    const expiredError = {
      headers: { req_id: "req-ambiguous-final" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    // placeholder ok; preview dies terminally; final skips the stream and the
    // first active push fails ambiguously; the retry push then succeeds.
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    mockClient.sendMessage.mockRejectedValueOnce(ackTimeout);
    mockClient.sendMessage.mockResolvedValue({} as any);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-ambiguous-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "预览片段", isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: "完整答案正文", isReasoning: false }, { kind: "final" });
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    await drainChunkTimers();

    // The ambiguous first attempt is also recorded on the mock; the retry
    // must produce a SECOND push that succeeds.
    const attempts = mockClient.sendMessage.mock.calls.filter((call) =>
      String((call[1] as any).markdown.content).includes("完整答案正文"),
    );
    expect(attempts.length).toBeGreaterThanOrEqual(2);
  });

  it("resends only unconfirmed chunks when the stream remainder push fails ambiguously", async () => {
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { loadConfig: () => ({}) } } as any);
    const ackTimeout = new Error("Reply ack timeout (5000ms) for reqId: req-remainder-ambiguous");
    // First chunk streams fine; the remainder active push fails ambiguously
    // once and then succeeds on the scheduled retry.
    mockClient.sendMessage.mockRejectedValueOnce(ackTimeout);
    mockClient.sendMessage.mockResolvedValue({} as any);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-remainder-ambiguous" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const finalText = `HEAD-MARK${"正文内容。".repeat(500)}TAIL-MARK`;
    const delivery = handle.deliver({ text: finalText, isReasoning: false }, { kind: "final" });
    await vi.advanceTimersByTimeAsync(800);
    await delivery;
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(String(mockClient.replyStream.mock.calls[0]?.[2])).toContain("HEAD-MARK");

    await vi.advanceTimersByTimeAsync(20_000);
    await drainChunkTimers();

    const pushedBodies = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    );
    // The stream-confirmed first chunk must never be re-pushed (a progress
    // identity drift would restart from chunk 0); the unconfirmed remainder
    // must be attempted twice: the ambiguous failure plus the retry.
    expect(pushedBodies.some((body) => body.includes("HEAD-MARK"))).toBe(false);
    expect(pushedBodies.filter((body) => body.includes("TAIL-MARK")).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("does not revive a partially visible superseded final through an ambiguous retry", async () => {
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { loadConfig: () => ({}) } } as any);
    const ackTimeout = new Error("Reply ack timeout (5000ms) for reqId: req-superseded-partial");
    // Superseded-final push: chunk 1 confirms, chunk 2 fails ambiguously.
    mockClient.sendMessage.mockResolvedValueOnce({} as any);
    mockClient.sendMessage.mockRejectedValueOnce(ackTimeout);
    mockClient.sendMessage.mockResolvedValue({} as any);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-superseded-partial" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "推理摘要", isReasoning: true }, { kind: "block" });
    await flushPromises();
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();

    const finalText = `${"旧任务正文。".repeat(700)}TAIL-MARK-OLD`;
    const delivery = handle.deliver({ text: finalText, isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    await delivery;
    const tailAttemptsBefore = mockClient.sendMessage.mock.calls.filter((call) =>
      String((call[1] as any).markdown.content).includes("TAIL-MARK-OLD"),
    ).length;

    // The user has already seen chunk 1 of the old answer; a later retry must
    // not push the stale remainder into the newest conversation.
    await vi.advanceTimersByTimeAsync(140_000);
    await drainChunkTimers();
    const tailAttemptsAfter = mockClient.sendMessage.mock.calls.filter((call) =>
      String((call[1] as any).markdown.content).includes("TAIL-MARK-OLD"),
    ).length;
    expect(tailAttemptsAfter).toBe(tailAttemptsBefore);
  });

  it("pushes one failure notice after the final retry chain is exhausted", async () => {
    const pushError = Object.assign(new Error("push rejected"), { errcode: 95001 });
    const expiredError = {
      headers: { req_id: "req-retry-exhausted-notice" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockResolvedValueOnce({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    mockClient.sendMessage.mockRejectedValue(pushError);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-retry-exhausted-notice" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "预览片段", isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: "重要答案", isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    // Exhaust the 20/40/80s retry chain.
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(80_000);
      await flushPromises();
    }

    mockClient.sendMessage.mockResolvedValue({} as any);
    const noticeAttempts = mockClient.sendMessage.mock.calls.filter((call) =>
      String((call[1] as any).markdown.content).includes("本次回复投递中断"),
    );
    expect(noticeAttempts).toHaveLength(1);
  });

  it("keeps an undelivered final retry alive across a new activation on the same peer", async () => {
    const pushError = Object.assign(new Error("push rejected"), { errcode: 95001 });
    const expiredError = {
      headers: { req_id: "req-survive-activation" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.sendMessage.mockRejectedValueOnce(pushError);
    mockClient.sendMessage.mockResolvedValue({} as any);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-survive-activation" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    // Preview delivered and VISIBLE, but no final chunk ever reached the user:
    // the visible-preview flag alone must no longer let a new activation
    // destroy the pending final retry.
    await handle.deliver({ text: "预览片段", isReasoning: false }, { kind: "block" });
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    await handle.deliver({ text: "迟到的完整答案", isReasoning: false }, { kind: "final" });
    await flushPromises();

    // A new message activates a fresh handle for the same peer.
    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-survive-activation-next" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    }).activate?.();

    await vi.advanceTimersByTimeAsync(20_000);
    await drainChunkTimers();

    // First attempt failed (still recorded on the mock); the surviving retry
    // must produce a SECOND, successful push of the same final.
    const attempts = mockClient.sendMessage.mock.calls.filter((call) =>
      String((call[1] as any).markdown.content).includes("迟到的完整答案"),
    );
    expect(attempts.length).toBeGreaterThanOrEqual(2);
  });

  it("stays silent when a superseded reasoning-only handle receives an empty final", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-superseded-reasoning-empty-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "推理摘要", isReasoning: true }, { kind: "block" });
    await flushPromises();
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();

    await handle.deliver({ text: "", isReasoning: false }, { kind: "final" });
    await drainChunkTimers();

    // No stray "（回复完毕）" bubble may be pushed into the newer conversation.
    expect(
      mockClient.sendMessage.mock.calls.some((call) =>
        String((call[1] as any).markdown.content).includes(FINAL_COMPLETION_MARKER),
      ),
    ).toBe(false);
  });

  it("pushes the superseded final after reasoning previews even on an unreliable stream", async () => {
    const expiredError = {
      headers: { req_id: "req-unreliable-reasoning-superseded" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    // Reasoning preview send dies terminally, latching streamUpdateUnreliable
    // through the settled/unreliable guard path.
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    mockClient.replyStream.mockResolvedValue({} as any);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-unreliable-reasoning-superseded" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "推理摘要", isReasoning: true }, { kind: "block" });
    await flushPromises();
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();

    await handle.deliver({ text: "真实结论正文", isReasoning: false }, { kind: "final" });
    await drainChunkTimers();

    expect(
      mockClient.sendMessage.mock.calls.some((call) =>
        String((call[1] as any).markdown.content).includes("真实结论正文"),
      ),
    ).toBe(true);
  });

  it("keeps visible body context without reasoning in the no-visible-output failure bubble", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-mixed-preview-fail" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });
    await flushPromises();

    await handle.deliver({ text: "Analyzing rollout plan", isReasoning: true }, { kind: "block" });
    await flushPromises();
    await handle.deliver({ text: "已完成前置检查。", isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(3_100);
    await flushPromises();

    const noVisibleOutput = new Error(
      "WeCom Bot WS reply produced no visible output for agent:main:wecom:direct:alice.",
    );
    noVisibleOutput.name = "WeComReplyNoVisibleOutputError";
    const failResult = handle.fail?.(noVisibleOutput);
    await vi.advanceTimersByTimeAsync(6_000);
    await failResult;

    const finalCall = mockClient.replyStream.mock.calls.at(-1);
    expect(finalCall?.[3]).toBe(true);
    const bubble = String(finalCall?.[2]);
    expect(bubble).toContain("已完成前置检查。");
    expect(bubble).toContain("本次回复投递中断");
    expect(bubble).not.toContain("Analyzing rollout plan");
  });

  it("sends only the failure notice when a no-visible-output reply had shown reasoning previews", async () => {
    // Production regression: the fail path used to append the notice to the
    // reasoning preview, and the markdown sanitizer stripped the <think> tags,
    // promoting raw English reasoning summaries to visible bubble text.
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-reasoning-fail-notice" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });
    await flushPromises();

    await handle.deliver(
      { text: "Testing session creation with labeled keys", isReasoning: true },
      { kind: "block" },
    );
    await flushPromises();
    await handle.deliver(
      { text: "Implementing yield for pending completion", isReasoning: true },
      { kind: "block" },
    );
    await flushPromises();

    const noVisibleOutput = new Error(
      "WeCom Bot WS reply produced no visible output for agent:main:wecom:direct:alice.",
    );
    noVisibleOutput.name = "WeComReplyNoVisibleOutputError";
    const failResult = handle.fail?.(noVisibleOutput);
    await vi.advanceTimersByTimeAsync(6_000);
    await failResult;

    const finalCall = mockClient.replyStream.mock.calls.at(-1);
    expect(finalCall?.[3]).toBe(true);
    expect(finalCall?.[2]).toBe("⚠️ 本次回复投递中断，请稍后重试或重新发起提问。");
    expect(String(finalCall?.[2])).not.toContain("Testing session creation");
  });

  it("pushes the superseded final after only reasoning previews were shown", async () => {
    // A bubble that only ever showed collapsed thinking has no visible reply;
    // superseding it must not silently discard the run's real answer.
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-reasoning-superseded-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });
    await flushPromises();

    await handle.deliver({ text: "分析用户排班问题", isReasoning: true }, { kind: "block" });
    await flushPromises();

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();

    await handle.deliver({ text: "排班结果：晓艳周三补班。", isReasoning: false }, { kind: "final" });
    await drainChunkTimers();

    expect(mockClient.sendMessage).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({
        msgtype: "markdown",
        markdown: expect.objectContaining({
          content: expect.stringContaining("排班结果：晓艳周三补班。"),
        }),
      }),
    );
  });

  it("does not queue a supersede notice onto an old stream while its ack is pending", async () => {
    const pendingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
    };
    pendingClient.hasPendingReplyAck = vi.fn().mockReturnValue(true);
    const handle = createBotWsReplyHandle({
      client: pendingClient,
      frame: {
        headers: { req_id: "req-supersede-notice-pending-ack" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();

    expect(mockClient.replyStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_500);
    await flushPromises();
    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("does not reuse the callback req_id for a supersede notice after an ack timeout", async () => {
    const ackTimeout = new Error(
      "Reply ack timeout (5000ms) for reqId: req-supersede-after-ack-timeout",
    );
    mockClient.replyStream.mockRejectedValueOnce(ackTimeout);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-supersede-after-ack-timeout" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "尚未确认可见的旧正文" }, { kind: "block" });
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("does not reuse the callback req_id to close an empty final after an ack timeout", async () => {
    const ackTimeout = new Error(
      "Reply ack timeout (5000ms) for reqId: req-empty-final-after-ack-timeout",
    );
    mockClient.replyStream.mockRejectedValueOnce(ackTimeout);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-empty-final-after-ack-timeout" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "尚未确认可见的旧正文" }, { kind: "block" });
    await handle.deliver({ text: "" }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
  });

  it("soft-times out superseded notices and still delivers the old final by active push", async () => {
    mockClient.replyStream.mockImplementationOnce(
      () => new Promise(() => undefined) as any,
    );
    const onFail = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-supersede-notice-timeout" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await flushPromises();

    expect(onFail).not.toHaveBeenCalled();

    await handle.deliver({ text: "旧回复最终答案", isReasoning: false }, { kind: "final" });

    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: "旧回复最终答案" },
    });
  });

  it("does not overwrite an already visible old stream with a superseded notice", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-visible-before-supersede" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "旧回复已输出", isReasoning: false }, { kind: "final" });
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-visible-before-supersede" } }),
      expect.any(String),
      "旧回复已输出",
      true,
    );

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).not.toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-visible-before-supersede" } }),
      expect.any(String),
      "已收到新消息，合并思考。✅",
      true,
    );
  });

  it("matches superseded peer ids case-insensitively while keeping the original send target", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-superseded-case" },
        body: { from: { userid: "Alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();
    await handle.deliver({ text: "旧请求答案", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-superseded-case" } }),
      expect.any(String),
      "已收到新消息，合并思考。✅",
      true,
    );
    expect(mockClient.sendMessage).toHaveBeenCalledWith("Alice", {
      msgtype: "markdown",
      markdown: { content: "旧请求答案" },
    });
  });

  it("keeps the newer same-peer handle on the normal final stream path", async () => {
    const oldHandle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-a" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const newHandle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-b" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    oldHandle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();

    await oldHandle.deliver({ text: "旧请求答案", isReasoning: false }, { kind: "final" });
    await newHandle.deliver({ text: "新请求答案", isReasoning: false }, { kind: "final" });

    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: "旧请求答案" },
    });
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-b" } }),
      expect.any(String),
      "新请求答案",
      true,
    );
  });

  it("does not let a superseded old final dedupe the newer same-peer final", async () => {
    const oldHandle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-same-final-a" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const newHandle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-same-final-b" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    oldHandle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await flushPromises();

    await oldHandle.deliver({ text: "相同答案", isReasoning: false }, { kind: "final" });
    await newHandle.deliver({ text: "相同答案", isReasoning: false }, { kind: "final" });

    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: "相同答案" },
    });
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-same-final-b" } }),
      expect.any(String),
      "相同答案",
      true,
    );
  });

  it("delivers legal identical finals independently for different req_ids", async () => {
    const createHandle = (reqId: string) =>
      createBotWsReplyHandle({
        client: mockClient,
        frame: {
          headers: { req_id: reqId },
          body: { from: { userid: "alice" }, chattype: "single" },
        } as unknown as ReplyHandleParams["frame"],
        accountId: "default",
        inboundKind: "text",
        autoSendPlaceholder: false,
      });

    await createHandle("req-identical-final-a").deliver(
      { text: "合法的相同答案", isReasoning: false },
      { kind: "final" },
    );
    await createHandle("req-identical-final-b").deliver(
      { text: "合法的相同答案", isReasoning: false },
      { kind: "final" },
    );

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-identical-final-a" } }),
      expect.any(String),
      "合法的相同答案",
      true,
    );
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-identical-final-b" } }),
      expect.any(String),
      "合法的相同答案",
      true,
    );
  });

  it.each([
    [{ headers: { req_id: "req-invalid" }, errcode: 846605, errmsg: "invalid req_id" }],
    [
      {
        headers: { req_id: "req-expired" },
        errcode: 846608,
        errmsg: "stream message update expired (>6 minutes), cannot update",
      },
    ],
  ])("does not retry error reply when the ws reply window is already closed", async (error) => {
    const onFail = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: String(error.headers.req_id) },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });

    await handle.fail?.(error);

    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("sends simple fallback message for ordinary events without placeholders", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "event_req" },
        body: { chattype: "single", from: { userid: "alice" } },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "event",
    });

    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    // Events should not send stream placeholders
    expect(mockClient.replyStream).not.toHaveBeenCalled();

    handle.deliver({ text: "Event Reply", isReasoning: false }, { kind: "final" });
    await Promise.resolve();

    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: "Event Reply" },
    });
  });

  it("returns from event replies when active push hangs", async () => {
    mockClient.sendMessage.mockImplementationOnce(
      () => new Promise(() => undefined) as any,
    );
    const onFail = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "event_timeout_req" },
        body: { chattype: "single", from: { userid: "alice" } },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "event",
      onFail,
    });

    const delivery = handle.deliver({ text: "Event Reply", isReasoning: false }, { kind: "final" });
    await vi.advanceTimersByTimeAsync(8_000);
    await delivery;

    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0]?.[0]).toMatchObject({ name: "WeComReplyTimeoutError" });
  });

  it("sends replyWelcome for welcome events", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "welcome_req" },
        body: { chattype: "single", from: { userid: "bob" } },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "welcome",
    });

    handle.deliver({ text: "Hello Bob", isReasoning: false }, { kind: "final" });
    await Promise.resolve();

    expect(mockClient.replyWelcome).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "welcome_req" } }),
      {
        msgtype: "text",
        text: { content: "Hello Bob" },
      },
    );
  });

  it("returns from welcome replies when replyWelcome hangs", async () => {
    mockClient.replyWelcome.mockImplementationOnce(
      () => new Promise(() => undefined) as any,
    );
    const onFail = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "welcome_timeout_req" },
        body: { chattype: "single", from: { userid: "bob" } },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "welcome",
      onFail,
    });

    const delivery = handle.deliver({ text: "Hello Bob", isReasoning: false }, { kind: "final" });
    await vi.advanceTimersByTimeAsync(8_000);
    await delivery;

    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0]?.[0]).toMatchObject({ name: "WeComReplyTimeoutError" });
  });
});
