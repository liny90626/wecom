import os from "node:os";
import path from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import {
  getBotWsPushHandle,
  registerBotWsPushHandle,
  unregisterBotWsPushHandle,
} from "../../runtime.js";
import { uploadAndSendBotWsMedia } from "./media.js";
import {
  __resetBotWsReplyTestState,
  createBotWsReplyHandle,
  registerBotWsReplyOwner,
  retireBotWsReplyOwner,
} from "./reply.js";

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

  const clearDefaultPushHandle = () => {
    const handle = getBotWsPushHandle("default");
    if (handle) unregisterBotWsPushHandle("default", handle);
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    __resetBotWsReplyTestState();
    clearDefaultPushHandle();
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
        current: () => ({
          channels: {
            wecom: {},
          },
        }),
      },
    } as any);
  });

  afterEach(() => {
    clearDefaultPushHandle();
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

  it("sends only one successful placeholder before the eight-minute gate", async () => {
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

    vi.advanceTimersByTime(3000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    await handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });

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
    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "another account",
      "acct-b",
      { from: { userid: "shared-peer" }, chattype: "single" },
    ],
    [
      "another peer kind",
      "acct-a",
      { from: { userid: "bob" }, chatid: "shared-peer", chattype: "group" },
    ],
  ])("keeps placeholder activity isolated from %s with the same peer id", async (
    _label,
    otherAccountId,
    otherBody,
  ) => {
    const otherClient = {
      replyStream: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockResolvedValue({}),
      replyWelcome: vi.fn().mockResolvedValue({}),
    } as unknown as import("vitest").Mocked<WSClient>;
    const activeHandle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-keepalive-scope-active" },
        body: { from: { userid: "shared-peer" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "acct-a",
      inboundKind: "text",
    });
    createBotWsReplyHandle({
      client: otherClient,
      frame: {
        headers: { req_id: "req-keepalive-scope-other" },
        body: otherBody,
      } as unknown as ReplyHandleParams["frame"],
      accountId: otherAccountId,
      inboundKind: "text",
    });
    await flushPromises();
    expect(otherClient.replyStream).toHaveBeenCalledTimes(1);

    activeHandle.markExternalActivity?.();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();

    expect(otherClient.replyStream).toHaveBeenCalledTimes(1);
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
      chat_type: 1,
      markdown: { content: `最终正文\n\n${FINAL_COMPLETION_MARKER}` },
    });
  });

  it("retries a timed-out initial placeholder without starting a short cadence", async () => {
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
    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
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
    // task has been processing for eight minutes.
    expect(mockClient.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(8 * 60_000 - 5_600);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
    // The preview never became writable, so this progress has not been seen at
    // all — it travels out instead of being dropped. Body text is the answer in
    // progress, so it goes without the clock (the clock under an answer's last
    // push is the stale "长任务处理中" the field reported).
    expect(String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content)).toBe(
      "正在读取材料",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    // Already delivered above, so the repeat carries the status only — and a
    // status with nothing new to say waits out the quiet cadence.
    expect(String((mockClient.sendMessage.mock.calls[1]?.[1] as any).markdown.content)).toBe(
      "【长任务处理中，请勿打断，已用时13m00s】",
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

  // The block keeps the newest slice, so a code point can land on either cut.
  it.each([
    ["尾部边界", `${"a".repeat(2_999)}😀`],
    ["头部边界", `😀${"a".repeat(3_200)}`],
    ["两端都是", `😀${"a".repeat(3_200)}😀`],
  ])("does not split an emoji at the thinking boundary: %s", async (_name, reasoning) => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-code-point-boundary" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: reasoning, isReasoning: true }, { kind: "block" });

    const frame = String(mockClient.replyStream.mock.calls[0]?.[2] ?? "");
    const content = frame.replace(/^[\s\S]*?<think>/, "").replace(/<\/think>[\s\S]*$/, "");
    expect(content.length).toBeGreaterThan(0);
    // No half of a surrogate pair may survive the cut, at either end.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(content)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content)).toBe(false);
    expect(content.length).toBeLessThanOrEqual(3_000);
  });

  it("keeps the newest reasoning when the block is capped", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-tail-window" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      { text: `开头很久以前的推理${"填充".repeat(3_000)}最新的推理结论`, isReasoning: true },
      { kind: "block" },
    );

    const frame = String(mockClient.replyStream.mock.calls[0]?.[2] ?? "");
    expect(frame).toContain("最新的推理结论");
    expect(frame).not.toContain("开头很久以前的推理");
    // The user is told why the block starts mid-thought.
    expect(frame).toContain("较早的思考已省略");
  });

  it("keeps reasoning on an error final within the final stream wire budget", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-error-final-budget" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "r".repeat(3_000), isReasoning: true }, { kind: "block" });
    await handle.deliver(
      { text: "E".repeat(1_500), isReasoning: false, isError: true },
      { kind: "final" },
    );

    const finalFrame = String(
      mockClient.replyStream.mock.calls.find((call) => call[3] === true)?.[2] ?? "",
    );
    expect(finalFrame).toContain("<think>");
    expect(finalFrame).toContain("E".repeat(1_500));
    expect(finalFrame.length).toBeLessThanOrEqual(5_000);
    expect(Buffer.byteLength(finalFrame, "utf8")).toBeLessThanOrEqual(12_000);
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
    // Reasoning now goes through the body's own normalizer, so a script block
    // loses its payload too instead of only its tags.
    expect(progressText).toContain("<think>先内部结束</think>");
    expect(progressText).not.toContain("<script>");
    expect(progressText).not.toContain("alert(1)");
    expect(progressText.match(/<think>/g)).toHaveLength(1);
    expect(progressText.match(/<\/think>/g)).toHaveLength(1);
    expect(finalText).toBe("最终正文");
  });

  it.each(["分析完成<--", "分析完成<!--"])(
    "neutralises a dangling comment marker in thinking content: %s",
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
      // The model's own words stay; what must not survive is anything the
      // client could read as an opening tag and use to eat `</think>`.
      expect(progressText).toContain("分析完成");
      expect(progressText).toContain("</think>");
      expect(progressText).not.toContain("<--");
      expect(progressText).not.toContain("<!--");
      const inner = progressText.replace(/^[\s\S]*?<think>/, "").replace(/<\/think>[\s\S]*$/, "");
      expect(inner).not.toContain("<");
    },
  );

  // 现网反馈：「思考块一直输出到一定长度，就再也收不到消息了」。思考块按**头部**
  // 截断，一旦累计推理超过上限，渲染结果每一帧完全相同，等值判定直接把这条通道
  // 静音——用户看到的就是气泡停在某个长度不动了。
  it("keeps the thinking preview moving after the block reaches its cap", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-cap-freeze" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    // OpenClaw 的 thinking 是**累计快照**，每次都带上此前的全部内容。
    let reasoning = "";
    const marks: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const mark = `【第${i}段思考】`;
      marks.push(mark);
      reasoning += `${mark}${"推理正文".repeat(400)}`;
      await handle.deliver({ text: reasoning, isReasoning: true }, { kind: "block" });
      await vi.advanceTimersByTimeAsync(3_500);
      await flushPromises();
    }

    const frames = mockClient.replyStream.mock.calls.map((call) => String(call[2] ?? ""));
    expect(frames.length).toBeGreaterThanOrEqual(6);
    // 每一帧都在往前走，没有一帧和上一帧相同（相同就意味着通道会静音）。
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i]).not.toBe(frames[i - 1]);
    }
    // 最新的思考必须可见——用户要的是「现在在想什么」，不是开头三千字。
    expect(frames.at(-1)).toContain(marks.at(-1));
  });

  it("keeps the frame inside its budget when escaping expands the reasoning", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-expansion" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    // Every character escapes to four, the worst expansion this path can hit.
    await handle.deliver({ text: "<".repeat(6_000), isReasoning: true }, { kind: "block" });
    await handle.deliver({ text: "正文内容。".repeat(400), isReasoning: false }, { kind: "block" });

    for (const call of mockClient.replyStream.mock.calls) {
      const content = String(call[2] ?? "");
      expect(content.length).toBeLessThanOrEqual(3_500);
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(15_360);
    }
    const frame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(frame).toContain("&lt;");
    expect(frame).toContain("</think>");
  });

  // 现网反馈的第二个静止场景：思考结束、工具跑很久。心跳原本被直接排到第 8
  // 分钟，于是这段时间气泡在代码层面就是不动的，用户当它卡死。
  it("repaints a bubble that went stale while the run is doing tool work", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-tool-phase-silence" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "先梳理一下已知条件", isReasoning: true }, { kind: "block" });
    await flushPromises();
    const afterThinking = mockClient.replyStream.mock.calls.length;
    expect(afterThinking).toBeGreaterThan(0);

    // 思考结束，工具开始跑：这一刻之后气泡不会再有自发变化。
    handle.markRunActivity?.();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(mockClient.replyStream.mock.calls.length).toBe(afterThinking);

    await vi.advanceTimersByTimeAsync(31_000);
    await flushPromises();
    const frames = mockClient.replyStream.mock.calls.map((call) => String(call[2] ?? ""));
    // Exactly one repaint — a heartbeat that does not reset its own clock spins.
    expect(frames.length).toBe(afterThinking + 1);
    const stale = frames.at(-1) ?? "";
    // 计时上屏，而且已有内容一个都没丢。
    expect(stale).toContain("【处理中，已用时");
    expect(stale).toContain("先梳理一下已知条件");
    // 还没到长任务门槛，不能要求用户「请勿打断」。
    expect(stale).not.toContain("请勿打断");
    // 工具事件本身不得渲染成任何用户可见文字（禁改 35）。
    expect(stale).not.toMatch(/Tool Call|Exec|🧰/);

    // 之后按同一节奏继续，不空转也不加速。
    await vi.advanceTimersByTimeAsync(90_000);
    await flushPromises();
    expect(mockClient.replyStream.mock.calls.length).toBe(afterThinking + 2);
  });

  it("leaves a turn without tool work on the absolute long-task path", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-no-tool-silence" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "正在整理答案", isReasoning: true }, { kind: "block" });
    await flushPromises();
    const afterThinking = mockClient.replyStream.mock.calls.length;

    // 没有工具活动 ⇒ 沉默看门狗不上岗，回合仍按 8 分钟绝对门槛（v150 保底不变）。
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await flushPromises();
    expect(mockClient.replyStream.mock.calls.length).toBe(afterThinking);

    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1_000);
    await flushPromises();
    const frames = mockClient.replyStream.mock.calls.map((call) => String(call[2] ?? ""));
    expect(frames.length).toBeGreaterThan(afterThinking);
    expect(frames.at(-1)).toContain("【长任务处理中，请勿打断，已用时");
  });

  it("lets real progress reset the staleness clock instead of stacking a status on it", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-tool-phase-progress" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "开始分析", isReasoning: true }, { kind: "block" });
    await flushPromises();
    handle.markRunActivity?.();

    // 每 60 秒来一条真实自述：气泡一直在动，看门狗永远不该插话。
    const steps: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      steps.push(`第 ${i} 步已完成`);
      await handle.deliver(
        {
          text: steps.join("\n"),
          channelData: {
            openclawProgressKind: "preamble",
            openclawProgressSteps: [...steps],
            openclawProgressDroppedSteps: 0,
          },
        },
        { kind: "block" },
      );
      await flushPromises();
    }

    const frames = mockClient.replyStream.mock.calls.map((call) => String(call[2] ?? ""));
    expect(frames.some((frame) => frame.includes("【处理中，已用时"))).toBe(false);
    expect(frames.at(-1)).toContain("4）第 4 步已完成");
  });

  // 思考块与正文共用同一帧预算（3500 字符 / 12000 字节）。正文一旦在场，思考块
  // 必须让位，否则 3000 字符的思考会把答案预览压到 484 字符。
  it("gives the answer the bubble when a long thinking block and a long body compete", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-vs-body" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    let reasoning = "";
    let body = "";
    const bodyMarks: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      reasoning += `${"推理正文".repeat(400)}【思考${i}】`;
      await handle.deliver({ text: reasoning, isReasoning: true }, { kind: "block" });
      await vi.advanceTimersByTimeAsync(3_500);
      await flushPromises();
      const mark = `【正文${i}】`;
      bodyMarks.push(mark);
      body += `${"答案内容".repeat(125)}${mark}`;
      await handle.deliver({ text: body }, { kind: "block" });
      await vi.advanceTimersByTimeAsync(3_500);
      await flushPromises();
    }

    const frames = mockClient.replyStream.mock.calls.map((call) => String(call[2] ?? ""));
    // Ten deliveries, all under the 3 000-char preview freeze: every one paints.
    expect(frames.length).toBeGreaterThanOrEqual(8);
    for (const frame of frames) {
      expect(frame.length).toBeLessThanOrEqual(3_500);
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(15_360);
      const think = frame.match(/<think>([\s\S]*?)<\/think>/)?.[1] ?? "";
      const bodyPart = frame.replace(/^[\s\S]*?<\/think>\n/, "");
      // With an answer on screen the block is held to its reduced share; before
      // there is one, the reasoning may use the whole bubble.
      expect(think.length).toBeLessThanOrEqual(bodyPart ? 800 : 3_000);
    }

    const lastFrame = frames.at(-1) ?? "";
    const visibleBody = lastFrame.replace(/^[\s\S]*?<\/think>\n/, "");
    // The answer keeps the rest of the frame instead of the old 484-char sliver.
    expect(visibleBody.length).toBeGreaterThan(1_500);
    expect(lastFrame).toContain(bodyMarks.at(-1));
    // The block tracks the newest reasoning rather than freezing on its opening.
    expect(lastFrame).toContain("【思考5】");
    // Both halves keep moving; a frozen frame is what silenced the lane before.
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i]).not.toBe(frames[i - 1]);
    }
  });

  // B2：正文超过气泡阈值必须分段发送，且思考块不得改变正文的分段。
  it("segments a long final the same way whether or not a long thinking block rode along", async () => {
    const tail = "TAIL-B2-THINKING";
    const finalText = `${"这是一段很长的中文答复，用来验证分段发送与思考块互不影响。".repeat(320)}${tail}`;

    const runTurn = async (reqId: string, withReasoning: boolean) => {
      mockClient.replyStream.mockClear();
      mockClient.sendMessage.mockClear();
      const handle = createBotWsReplyHandle({
        client: mockClient,
        frame: {
          headers: { req_id: reqId },
          body: { from: { userid: "alice" }, chattype: "single" },
        } as unknown as ReplyHandleParams["frame"],
        accountId: "default",
        inboundKind: "text",
        autoSendPlaceholder: false,
      });
      if (withReasoning) {
        await handle.deliver(
          { text: `【长思考】${"推理正文".repeat(1_200)}`, isReasoning: true },
          { kind: "block" },
        );
        await vi.advanceTimersByTimeAsync(3_500);
        await flushPromises();
      }
      const deliverPromise = handle.deliver({ text: finalText }, { kind: "final" });
      await drainChunkTimers();
      await deliverPromise;
      const streamFrames = mockClient.replyStream.mock.calls.map((call) => String(call[2] ?? ""));
      const pushes = mockClient.sendMessage.mock.calls.map((call) =>
        String((call[1] as any).markdown.content),
      );
      return { streamFrames, pushes };
    };

    const withThinking = await runTurn("req-b2-with-thinking", true);
    const withoutThinking = await runTurn("req-b2-plain", false);

    const finalFrame = withThinking.streamFrames.at(-1) ?? "";
    // 第一段走被动流，其余分段主动推送——阈值以上必须分段，不能只发一段。
    expect(finalFrame).toContain("【第1/");
    expect(finalFrame).not.toContain(tail);
    expect(withThinking.pushes.length).toBeGreaterThan(0);
    expect(withThinking.pushes.join("\n")).toContain(tail);
    expect(withThinking.pushes.join("\n")).toMatch(/【第\d+\/\d+段】/);
    // 成功 final 只留答案，思考块不占它的分段预算（禁改 v147）。
    expect(finalFrame).not.toContain("<think>");
    const segmentsOf = (text: string) => text.match(/【第\d+\/(\d+)段】/)?.[1];
    expect(segmentsOf(finalFrame)).toBe(segmentsOf(withoutThinking.streamFrames.at(-1) ?? ""));
    expect(withThinking.pushes.length).toBe(withoutThinking.pushes.length);
  });

  // 现网反馈：「思考块内容过长时消息回复失败——气泡里只有思考块，没有答案」。
  // 思考块曾是唯一没走正文归一化的通道：裸 `<` 让客户端把 `</think>` 当成标签
  // 内容吃掉，块不闭合，后面的答案跟着消失。长思考只是提高了命中裸 `<`／被截断
  // 代码围栏的概率，不是尺寸越界（帧始终在 3500 字符 / 12000 字节内）。
  it.each([
    ["行内比较符", "先判断 if (retries < maxRetries) 再决定是否重试。"],
    ["泛型签名", "返回值是 Map<string, item> 这种形状。"],
    ["被截断的代码围栏", "先看实现：\n```ts\nconst budget = limit - prefix.length;"],
    ["跨行标签", "配置片段：\n<config\n  timeout=900>\n继续分析。"],
  ])("keeps the answer visible when reasoning contains %s", async (_name, thinkingText) => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-swallow" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: thinkingText, isReasoning: true }, { kind: "block" });
    await handle.deliver({ text: "这是最终答案。", isReasoning: false }, { kind: "final" });

    const progressText = String(mockClient.replyStream.mock.calls[0]?.[2] ?? "");
    const inner = progressText.replace(/^[\s\S]*?<think>/, "").replace(/<\/think>[\s\S]*$/, "");
    // Nothing inside the block may open a tag or a fence that outlives it.
    expect(inner).not.toContain("<");
    expect((inner.match(/```/g) ?? []).length % 2).toBe(0);
    expect(progressText.match(/<think>/g)).toHaveLength(1);
    expect(progressText.match(/<\/think>/g)).toHaveLength(1);
    expect(String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "")).toContain("这是最终答案。");
  });

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
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(15_360);

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
    expect(Buffer.byteLength(fastPreview, "utf8")).toBeLessThanOrEqual(15_360);
  });

  it("re-sends body text replaced by a Fast status before stream expiry", async () => {
    const expiredError = {
      headers: { req_id: "req-fast-replaced-body-expired" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream
      .mockResolvedValueOnce({} as any)
      .mockResolvedValueOnce({} as any)
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(expiredError);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-fast-replaced-body-expired" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const hiddenSentinel = "FAST-HIDDEN-SENTINEL";
    const bodyText = `${"A".repeat(2_000)}${hiddenSentinel}${"B".repeat(600)}`;
    const fastText = "💨Fast: auto-off(62s>=60s)";
    const stepText = `正在核对第一批配置项与运行记录，${"逐条比对默认值。".repeat(100)}`;

    await handle.deliver({ text: "r".repeat(3_000), isReasoning: true }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(3_000);
    await handle.deliver({ text: bodyText }, { kind: "block" });
    const bodyPreview = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(bodyPreview).toContain(hiddenSentinel);

    // The transient lane owns the frame: log tail plus the Fast banner push the
    // body's tail off this revision, and the bookmark has to follow it back.
    await handle.deliver(
      {
        text: stepText,
        channelData: {
          openclawProgressKind: "preamble",
          openclawProgressSteps: [stepText],
          openclawProgressDroppedSteps: 0,
        },
      },
      { kind: "block" },
    );
    await handle.deliver(
      { text: fastText, channelData: { openclawProgressKind: "fast-mode-auto" } },
      { kind: "block" },
    );
    const fastPreview = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(fastPreview).toContain(fastText);
    expect(fastPreview).not.toContain(hiddenSentinel);

    await handle.deliver({ text: `${bodyText}\n最终新增内容` }, { kind: "final" });

    const pushed = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    ).join("\n");
    expect(pushed).toContain(hiddenSentinel);
    expect(pushed).toContain("最终新增内容");
    expect(pushed).not.toContain(fastText);
  });

  it("still delivers a superseded turn's real final after Fast-only progress", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-fast-superseded-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      {
        text: "💨Fast: auto-off(62s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      },
      { kind: "block" },
    );
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });

    await handle.deliver({ text: "旧任务仍有真实最终答案" }, { kind: "final" });

    const pushed = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    ).join("\n");
    expect(pushed).toContain("旧任务仍有真实最终答案");
  });

  it("keeps the last visible progress when a turn closes without a body", async () => {
    // WeCom stream frames carry the FULL bubble content, so finishing the
    // stream with "" blanks whatever the user was already reading.
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-empty-final-close" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const fastText = "💨Fast: auto-off(62s>=60s)";

    await handle.deliver(
      { text: fastText, channelData: { openclawProgressKind: "fast-mode-auto" } },
      { kind: "block" },
    );
    await handle.deliver({ text: "" }, { kind: "final" });

    const lastCall = mockClient.replyStream.mock.calls.at(-1);
    expect(lastCall?.[3]).toBe(true);
    expect(String(lastCall?.[2] ?? "")).toContain(fastText);
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

  it("keeps escaped literal think tags within the wire budget on preview and final routes", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-literal-think-wire-budget" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const text = Array.from({ length: 700 }, () => "`<think>`").join("\n");

    await handle.deliver({ text }, { kind: "block" });
    const preview = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(preview).toContain("&lt;think&gt;");
    expect(preview.length).toBeLessThanOrEqual(3_500);
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(15_360);

    const finalDelivery = handle.deliver({ text }, { kind: "final" });
    await drainChunkTimers();
    await finalDelivery;
    const finalFrames = mockClient.replyStream.mock.calls
      .filter((call) => call[3] === true)
      .map((call) => String(call[2] ?? ""));
    const pushedFrames = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    );
    expect(finalFrames.length).toBeGreaterThan(0);
    for (const frame of finalFrames) {
      expect(frame.length).toBeLessThanOrEqual(5_000);
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(15_360);
    }
    expect(pushedFrames.length).toBeGreaterThan(0);
    for (const frame of pushedFrames) {
      expect(frame.length).toBeLessThanOrEqual(5_000);
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(15_360);
    }
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
    expect(firstPreview).not.toContain("长任务处理中");

    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    const secondPreview = String(mockClient.replyStream.mock.calls[1]?.[2] ?? "");
    expect(secondPreview).toContain("预览内容。");
    expect(secondPreview).toContain("【长任务处理中，请勿打断，已用时8m00s】");
    expect(secondPreview).not.toContain("END-FROZEN");

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(String(mockClient.replyStream.mock.calls[2]?.[2] ?? "")).toContain(
      "【长任务处理中，请勿打断，已用时9m00s】",
    );
  });

  it("does not spin zero-delay timers while a frozen status ACK is in flight", async () => {
    mockClient.replyStream
      .mockResolvedValueOnce({} as any)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({}), 25);
          }) as any,
      );
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-frozen-status-in-flight" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "预览内容。".repeat(700) }, { kind: "block" });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await vi.advanceTimersByTimeAsync(8 * 60_000 + 25);
    await flushPromises();

    const zeroDelayTimers = timeoutSpy.mock.calls.filter((call) => call[1] === 0);
    expect(zeroDelayTimers).toHaveLength(0);
    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
  });

  it("does not rearm frozen status after supersede while its ACK is in flight", async () => {
    let releaseStatusAck!: (value: unknown) => void;
    mockClient.replyStream
      .mockResolvedValueOnce({} as any)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseStatusAck = resolve;
          }) as any,
      );
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-frozen-status-superseded" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "预览内容。".repeat(700) }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    releaseStatusAck({});
    await flushPromises();

    expect(timeoutSpy.mock.calls.filter((call) => call[1] === 0)).toHaveLength(0);
  });

  it("does not retry frozen status faster than the status cadence when its ACKs never arrive", async () => {
    // A stream that keeps taking frames but never acknowledges them latches
    // streamAckUnreliable WITHOUT killing the bubble, so the frozen-status lane
    // stays armed. Its slot is only spent on a CONFIRMED frame, so every failed
    // cycle used to leave the slot due and re-arm on a zero delay — the lane
    // then re-sent the same failing frame several times a second for the rest
    // of the turn instead of once a minute.
    mockClient.replyStream.mockRejectedValue(new Error("ack timeout"));
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-frozen-status-ack-never-arrives" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "预览内容。".repeat(700) }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();

    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const streamCallsBefore = mockClient.replyStream.mock.calls.length;
    const virtualStart = Date.now();
    for (let step = 0; step < 200; step += 1) {
      await vi.advanceTimersToNextTimerAsync();
    }

    expect(timeoutSpy.mock.calls.filter((call) => call[1] === 0)).toHaveLength(0);
    // 200 timer steps must cover far more than a couple of status slots; a
    // spinning lane burned them all inside ~80 simulated seconds.
    const elapsedMs = Date.now() - virtualStart;
    expect(elapsedMs).toBeGreaterThan(30 * 60_000);
    const streamCalls = mockClient.replyStream.mock.calls.length - streamCallsBefore;
    expect(streamCalls).toBeLessThan(elapsedMs / 60_000);
  });

  it("keeps an expired callback claim on recurring push without reviving its frozen stream", async () => {
    const callbackClaimExpiresAt = Date.now() + 8 * 60_000;
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-frozen-status-expired-claim" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      isCallbackStreamCurrent: () => Date.now() < callbackClaimExpiresAt,
    });

    await handle.deliver({ text: "预览内容。".repeat(700) }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    // The frozen body travels on the push lane; body text never carries the clock.
    const firstPush = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(firstPush).toContain("预览内容。");
    expect(firstPush).not.toContain("已用时");

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(String((mockClient.sendMessage.mock.calls[1]?.[1] as any).markdown.content)).toContain(
      "【长任务处理中，请勿打断，已用时13m00s】",
    );
  });

  it("sends a template card as its own message and keeps its JSON out of the reply", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-template-card-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const cardBlock =
      "```json\n" +
      JSON.stringify({
        card_type: "vote_interaction",
        title: "午饭吃什么",
        options: [
          { id: "a", text: "面" },
          { id: "b", text: "饭" },
        ],
      }) +
      "\n```";
    await handle.deliver({ text: `帮你发起投票：\n\n${cardBlock}\n\n投完告诉我。` }, { kind: "final" });
    await flushPromises();

    const cardPushes = mockClient.sendMessage.mock.calls.filter(
      (call) => (call[1] as any)?.msgtype === "template_card",
    );
    expect(cardPushes).toHaveLength(1);
    const card = (cardPushes[0]?.[1] as any).template_card;
    expect(card.card_type).toBe("vote_interaction");
    expect(card.checkbox.option_list).toEqual([
      { id: "a", text: "面" },
      { id: "b", text: "饭" },
    ]);

    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame).toContain("帮你发起投票");
    expect(finalFrame).toContain("投完告诉我");
    expect(finalFrame).not.toContain("card_type");
  });

  it("closes a card-only reply on a confirmation instead of an empty bubble", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-template-card-only" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const cardBlock =
      "```json\n" +
      JSON.stringify({ card_type: "text_notice", main_title: { title: "发布完成" } }) +
      "\n```";
    await handle.deliver({ text: cardBlock }, { kind: "final" });
    await flushPromises();

    expect(
      mockClient.sendMessage.mock.calls.filter(
        (call) => (call[1] as any)?.msgtype === "template_card",
      ),
    ).toHaveLength(1);
    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame).toContain("卡片消息已发送");
    expect(finalFrame).not.toContain("card_type");
  });

  it("says so when a detected card could not be sent", async () => {
    // The JSON is gone from the text by then, so silence would leave the turn
    // looking answered while the user received nothing.
    mockClient.sendMessage.mockRejectedValueOnce(new Error("card rejected"));
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-template-card-failed" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const cardBlock =
      "```json\n" +
      JSON.stringify({ card_type: "text_notice", main_title: { title: "发布完成" } }) +
      "\n```";
    await handle.deliver({ text: cardBlock }, { kind: "final" });
    await flushPromises();

    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame).toContain("卡片消息发送失败");
    expect(finalFrame).not.toContain("card_type");
  });

  it("never streams raw card JSON while the model is still writing it", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-template-card-preview" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: '帮你发起投票：\n\n```json\n{\n  "card_type": "vote' }, {
      kind: "block",
    });
    await flushPromises();

    const previewFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(previewFrame).toContain("帮你发起投票");
    expect(previewFrame).toContain("正在生成卡片消息");
    expect(previewFrame).not.toContain("card_type");
  });

  it("does not push the same card twice when the final is delivered again", async () => {
    // A card cannot be recalled, and this handle's final can legitimately be
    // delivered more than once (a close followed by a handoff notice, a retry).
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-template-card-twice" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const cardBlock =
      "```json\n" +
      JSON.stringify({ card_type: "text_notice", main_title: { title: "发布完成" } }) +
      "\n```";
    await handle.deliver({ text: `已完成。\n\n${cardBlock}` }, { kind: "final" });
    await handle.deliver({ text: `已完成。\n\n${cardBlock}` }, { kind: "final" });
    await flushPromises();

    expect(
      mockClient.sendMessage.mock.calls.filter(
        (call) => (call[1] as any)?.msgtype === "template_card",
      ),
    ).toHaveLength(1);
  });

  it("delivers the actionable error OpenClaw sends after its generic one", async () => {
    // Production 2026-08-29: a run that exceeded agents.defaults.timeoutSeconds
    // emitted "LLM request failed." and then "Request timed out … increase
    // agents.defaults.timeoutSeconds". The dedup dropped the second one, so the
    // user was told the model failed and never told which knob to turn.
    const expiredError = {
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockRejectedValue(expiredError);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-final-after-error" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "LLM request failed.", isError: true }, { kind: "final" });
    await flushPromises();
    await handle.deliver(
      {
        text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
        isError: true,
      },
      { kind: "final" },
    );
    await flushPromises();

    const pushed = mockClient.sendMessage.mock.calls
      .map((call) => String((call[1] as any)?.markdown?.content ?? ""))
      .join("\n");
    expect(pushed).toContain("LLM request failed.");
    expect(pushed).toContain("agents.defaults.timeoutSeconds");
  });

  it("still drops a distinct second final once a real answer was delivered", async () => {
    // The dedup exists for retries of the same answer; only an error final may
    // be followed by another message.
    const expiredError = {
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockRejectedValue(expiredError);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-final-after-answer" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "这是真正的答案。" }, { kind: "final" });
    await flushPromises();
    await handle.deliver({ text: "另一段完全不同的内容。" }, { kind: "final" });
    await flushPromises();

    const pushed = mockClient.sendMessage.mock.calls
      .map((call) => String((call[1] as any)?.markdown?.content ?? ""))
      .join("\n");
    expect(pushed).toContain("这是真正的答案。");
    expect(pushed).not.toContain("另一段完全不同的内容。");
  });

  it("keeps carrying the thinking window after the WeCom window dies", async () => {
    // Production 2026-08-29: a 10-minute run streamed 126k characters of
    // reasoning and ~1k of body. The bubble updated for the first six minutes
    // and then went completely silent — the window closed, and the push lane
    // carried body only, so everything the model produced afterwards was
    // dropped. The user saw a clock and nothing else.
    const start = Date.now();
    const windowDiesAt = start + 6 * 60_000;
    const expired = { errcode: 846608, errmsg: "stream message update expired" };
    const streamed: string[] = [];
    const pushed: string[] = [];
    const streamSink = async (_frame: unknown, _streamId: unknown, text: string) => {
      if (Date.now() >= windowDiesAt) throw expired;
      streamed.push(String(text));
      return {} as never;
    };
    mockClient.replyStream.mockImplementation(streamSink as never);
    (mockClient as unknown as { replyStreamNonBlocking?: unknown }).replyStreamNonBlocking =
      vi.fn(streamSink);
    mockClient.sendMessage.mockImplementation((async (_chatId: unknown, body: unknown) => {
      pushed.push(String((body as { markdown?: { content?: string } })?.markdown?.content ?? ""));
      return {} as never;
    }) as never);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-thinking-after-window" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "main",
      inboundKind: "text",
      autoSendPlaceholder: false,
      // The plugin's own req_id claim lives 8 minutes.
      isCallbackStreamCurrent: () => Date.now() < start + 8 * 60_000,
    });

    await handle.deliver({ text: "子任务已在跑。" }, { kind: "block" });
    await flushPromises();

    let reasoning = "";
    for (let tick = 0; tick < 300; tick += 1) {
      reasoning += `第 ${tick} 段推理：正在检查配置并等待子任务返回结果。`;
      await handle.deliver({ text: reasoning, isReasoning: true }, { kind: "block" });
      await vi.advanceTimersByTimeAsync(2_000);
      await flushPromises();
    }

    // The bubble worked while it could.
    expect(streamed.filter((frame) => frame.includes("<think>")).length).toBeGreaterThan(10);
    // ...and the push lane has to take over, still carrying the reasoning.
    const thinkingPushes = pushed.filter((frame) => frame.includes("<think>"));
    expect(thinkingPushes.length).toBeGreaterThan(2);
    // Each one shows where the model has got to, not a frozen snapshot.
    expect(thinkingPushes.at(0)).not.toBe(thinkingPushes.at(-1));
    // The status line it exists to carry is never crowded out.
    expect(pushed.at(-1)).toContain("长任务处理中");
    // The think wrapper must survive the wire escaping the body text goes through.
    expect(pushed.at(-1)).not.toContain("&lt;think&gt;");
  });

  it("does not treat an ordinary code block as a card", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-plain-code-block" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: '配置：\n\n```json\n{"retries": 3}\n```' }, { kind: "final" });
    await flushPromises();

    expect(
      mockClient.sendMessage.mock.calls.filter(
        (call) => (call[1] as any)?.msgtype === "template_card",
      ),
    ).toHaveLength(0);
    expect(String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "")).toContain("retries");
  });

  it("does not split an emoji when freezing the preview character boundary", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-preview-code-point-boundary" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      { text: `${"a".repeat(2_999)}😀`, isReasoning: false },
      { kind: "block" },
    );

    expect(String(mockClient.replyStream.mock.calls[0]?.[2] ?? "")).toBe(
      "a".repeat(2_999),
    );
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
    expect(statusContents().at(-1)).not.toContain("长任务处理中");
    expect(statusContents().at(-1)).not.toContain("当前用时0s");

    await vi.advanceTimersByTimeAsync(8 * 60_000 - 65_000);
    await flushPromises();
    expect(statusContents().at(-1)).toContain(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(statusContents().at(-1)).toContain(
      "【长任务处理中，请勿打断，已用时9m00s】",
    );
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

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-preview-time-freeze" } }),
      expect.any(String),
      "正在查询数据源\n\n【长任务处理中，请勿打断，已用时8m00s】",
      false,
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(3);
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
    const longBlock = "预览内容。".repeat(1_800);

    await handle.deliver({ text: longBlock, isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(8 * 60_000);
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
      chat_type: 1,
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

  it("keeps a pre-existing completion marker single and last across long chunks", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-existing-completion-marker" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const text = `${"已有正文。".repeat(2_200)}\n\n${FINAL_COMPLETION_MARKER}`;

    const delivery = handle.deliver({ text }, { kind: "final" });
    await drainChunkTimers();
    await delivery;

    const wireFrames = [
      ...mockClient.replyStream.mock.calls
        .filter((call) => call[3] === true)
        .map((call) => String(call[2] ?? "")),
      ...mockClient.sendMessage.mock.calls.map((call) =>
        String((call[1] as any).markdown.content),
      ),
    ];
    expect(wireFrames.join("\n").match(/（回复完毕）/g)).toHaveLength(1);
    expect(wireFrames.at(-1)).toMatch(/【第\d+\/\d+段】\n\n（回复完毕）$/);
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
        current: () => ({}),
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
        current: () => ({}),
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

  it("does not repeat the answer when the core leaves a MEDIA directive in the block", async () => {
    // OpenClaw streams block replies with `extractMediaDirectives: false`, so
    // the directive is still in the block text; the final has it stripped AND
    // every blank line collapsed (splitMediaFromOutput). Accumulating the block
    // verbatim showed the user a raw local path and left the final unable to
    // match the accumulated body, so the whole answer was sent a second time.
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
    const answer = "评估完成，核心结论：\n\nC 盘剩 26.4GB。\n\n清理方案四档：A/B/C/D。";
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-directive" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      { text: `${answer}\n\nMEDIA:C:\\Users\\me\\report.md` },
      { kind: "block" },
    );
    await handle.deliver(
      {
        text: answer.replace(/\n{2,}/g, "\n"),
        mediaUrls: ["C:\\Users\\me\\report.md"],
      },
      { kind: "final" },
    );

    const frames = mockClient.replyStream.mock.calls.map((call) => String(call[2] ?? ""));
    const finalFrame = frames.at(-1) ?? "";
    expect(finalFrame).not.toContain("MEDIA:");
    expect(finalFrame.split("评估完成，核心结论：")).toHaveLength(2);
    expect(finalFrame).toContain("清理方案四档：A/B/C/D。");
  });

  it("keeps a MEDIA line whose payload is prose rather than a file", async () => {
    // The core only treats a directive as media when the payload resolves to a
    // URL, a path or a filename; anything else stays in the text. Dropping it
    // here would delete a line of the model's answer.
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
    const answer = "结论如下：\n\nMEDIA: 这一段是说明文字，不是附件";
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-prose" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: answer }, { kind: "block" });
    await handle.deliver({ text: answer }, { kind: "final" });

    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame).toContain("MEDIA: 这一段是说明文字，不是附件");
    expect(finalFrame.split("结论如下：")).toHaveLength(2);
  });

  it("does not repeat the answer when the blocks re-send it as it grows", async () => {
    // A producer that streams cumulative text puts the directive in the LAST
    // block only. Normalizing that block alone (and not the ones before it)
    // left the two shapes unalignable and appended the answer all over again.
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
    const opening = "评估完成，核心结论：\n\nC 盘剩 26.4GB。";
    const answer = `${opening}\n\n清理方案四档：A/B/C/D。`;
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-cumulative" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: opening }, { kind: "block" });
    await handle.deliver(
      { text: `${answer}\n\nMEDIA:C:\\Users\\me\\report.md` },
      { kind: "block" },
    );
    await handle.deliver(
      {
        text: answer.replace(/\n{2,}/g, "\n"),
        mediaUrls: ["C:\\Users\\me\\report.md"],
      },
      { kind: "final" },
    );

    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame).not.toContain("MEDIA:");
    expect(finalFrame.split("评估完成，核心结论：")).toHaveLength(2);
    expect(finalFrame.split("清理方案四档：A/B/C/D。")).toHaveLength(2);
  });

  it("keeps the words sharing a line with the attachment", async () => {
    // The core removes the tokens it accepted and keeps the rest of the line;
    // dropping the whole line deleted a sentence of the model's answer.
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-inline-words" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      { text: "答案在这里。\n\nMEDIA: https://example.com/a.png 请查收" },
      { kind: "block" },
    );
    await handle.deliver(
      { text: "答案在这里。\n请查收", mediaUrls: ["https://example.com/a.png"] },
      { kind: "final" },
    );

    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame).toContain("请查收");
    expect(finalFrame).not.toContain("MEDIA:");
    expect(finalFrame.split("答案在这里。")).toHaveLength(2);
  });

  it("matches the core on which targets count as an attachment", async () => {
    // A long extension is a filename the core takes; a non-https URL is one it
    // refuses and leaves in the text. Diverging either way puts the bubble and
    // the final back out of step.
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-target-shapes" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      { text: "答案。\n\nMEDIA: 报告.markdown\nMEDIA:http://example.com/a.png" },
      { kind: "block" },
    );
    await handle.deliver(
      { text: "答案。\nMEDIA:http://example.com/a.png", mediaUrls: ["报告.markdown"] },
      { kind: "final" },
    );

    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame).not.toContain("报告.markdown");
    expect(finalFrame).toContain("MEDIA:http://example.com/a.png");
    expect(finalFrame.split("答案。")).toHaveLength(2);
  });

  it("does not repeat a short attachment answer that followed earlier blocks", async () => {
    // Multi-block turn whose final is short: the length floor on the content
    // comparison is there for finals whose spacing the core never touched, and
    // a turn carrying a directive is not one of those.
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-short-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "先扫描一遍。" }, { kind: "block" });
    await handle.deliver(
      { text: "评估完成。\n\n报告见附件。\nMEDIA:C:\\Users\\me\\report.md" },
      { kind: "block" },
    );
    await handle.deliver(
      { text: "评估完成。\n报告见附件。", mediaUrls: ["C:\\Users\\me\\report.md"] },
      { kind: "final" },
    );

    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame).toContain("先扫描一遍。");
    expect(finalFrame.split("评估完成。")).toHaveLength(2);
    expect(finalFrame.split("报告见附件。")).toHaveLength(2);
  });

  it("does not repeat the answer when the final carries more than the blocks", async () => {
    // The shape `next.startsWith(base)` exists for: a producer re-sending its
    // text as it grows. Once the core respaces the final, that raw prefix test
    // fails and the whole answer used to be appended to itself.
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-superset-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "第一段结论。\n\n第二段结论。" }, { kind: "block" });
    await handle.deliver(
      { text: "第一段结论。\n第二段结论。\n第三段结论。", mediaUrls: ["/tmp/a.png"] },
      { kind: "final" },
    );

    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame.split("第一段结论。")).toHaveLength(2);
    expect(finalFrame.split("第二段结论。")).toHaveLength(2);
    expect(finalFrame).toContain("第三段结论。");
  });

  it("keeps the newer text when a correction differs by more than spacing", async () => {
    // The spacing-blind compare must not let an older block win over a final
    // that actually says something different.
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-correction" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "内存 15GB。" }, { kind: "block" });
    await handle.deliver(
      { text: "内存 1.5GB。", mediaUrls: ["/tmp/a.png"] },
      { kind: "final" },
    );

    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame).toContain("内存 1.5GB。");
  });

  it("keeps the words between two attachments on one directive line", async () => {
    // The core only retries the whole payload as one path when a SINGLE token
    // matched; with two, what sits between them is prose. Swallowing it left
    // the body unable to line up with the final — the answer twice again.
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-two-targets" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      { text: "第一段。\n\nMEDIA: 见 /tmp/a.png 与 /tmp/b.png 的对比\n\n第二段。" },
      { kind: "block" },
    );
    await handle.deliver(
      {
        text: "第一段。\n见 与 的对比\n第二段。",
        mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
      },
      { kind: "final" },
    );

    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame).not.toContain("MEDIA:");
    expect(finalFrame.split("第一段。")).toHaveLength(2);
    expect(finalFrame.split("第二段。")).toHaveLength(2);
  });

  it("keeps a block that re-sends the same words with new indentation", async () => {
    // The spacing-blind compare exists to absorb the core's respacing, which
    // never touches indentation. A model showing a wrong form and then the
    // corrected one has to keep both.
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-reindented-block" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "def f():\nreturn 1" }, { kind: "block" });
    await handle.deliver({ text: "def f():\n    return 1" }, { kind: "block" });
    await handle.deliver({ text: "以上。" }, { kind: "final" });

    // The indented copy reaches WeCom through the markdown adapter, which
    // labels an indented code block rather than passing the spaces through —
    // what matters here is that the second block survived the merge at all.
    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame.split("def f():")).toHaveLength(3);
    expect(finalFrame).toContain("代码：");
  });

  it("keeps a MEDIA line that belongs to a fenced code sample", async () => {
    // The core keeps fenced lines and then leaves the whole text untouched, so
    // touching it here would reintroduce the mismatch this strip exists to end.
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
    const answer = "用法如下：\n\n```\nMEDIA:/path/to/file.png\n```\n\n就这样。";
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-fence" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: answer }, { kind: "block" });
    await handle.deliver({ text: answer }, { kind: "final" });

    const finalFrame = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalFrame).toContain("MEDIA:/path/to/file.png");
    expect(finalFrame.split("用法如下：")).toHaveLength(2);
  });

  it("stops a media final after supersede makes the first attachment visible", async () => {
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: {
        current: () => ({}),
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
        current: () => ({}),
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
        current: () => ({}),
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
    const current = vi.fn().mockImplementationOnce(() => {
      throw configError;
    }).mockReturnValue({});
    runtime.setWecomRuntime({ config: { current } } as any);
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
        current: () => ({
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
      chat_type: 1,
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
    mockClient.replyStream.mockRejectedValue(expiredError);
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
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();
    await handle.deliver({ text: "预览之后继续处理", isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: "最终正文", isReasoning: false }, { kind: "final" });

    expect(onFail).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      chat_type: 1,
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
    mockClient.replyStream.mockRejectedValue(expiredError);
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
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();
    await handle.deliver({ text: "压测结果完成", isReasoning: false }, { kind: "final" });

    expect(onFail).not.toHaveBeenCalled();
    const pushedContents = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    );
    expect(pushedContents).toContain(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );
    const finalPush = pushedContents.find((content) => content.includes("压测结果完成"));
    expect(finalPush).toBeDefined();
    expect(finalPush).toContain("继续输出：");
    expect(finalPush).toContain(FINAL_COMPLETION_MARKER);

    // The final settles the recurring status timer permanently.
    const pushCountAfterFinal = mockClient.sendMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(pushCountAfterFinal);
  });

  it("starts the recurring background status when the task is still running at eight minutes", async () => {
    const expiredError = {
      headers: { req_id: "req-nine-minute-notice" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
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
    await vi.advanceTimersByTimeAsync(8 * 60_000 - 1);
    await flushPromises();

    expect(
      mockClient.sendMessage.mock.calls.some((call) =>
        String((call[1] as any).markdown.content).includes("【长任务处理中，请勿打断，已用时"),
      ),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    const noticePushes = mockClient.sendMessage.mock.calls.filter((call) =>
      String((call[1] as any).markdown.content).includes("【长任务处理中，请勿打断，已用时"),
    );
    expect(noticePushes).toHaveLength(1);

    // A status line with nothing new to say is just the clock: it repeats on
    // the quiet cadence instead of once a minute.
    await vi.advanceTimersByTimeAsync(180_000);
    await flushPromises();
    expect(
      mockClient.sendMessage.mock.calls.filter((call) =>
        String((call[1] as any).markdown.content).includes("【长任务处理中，请勿打断，已用时"),
      ),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await flushPromises();
    expect(
      mockClient.sendMessage.mock.calls.filter((call) =>
        String((call[1] as any).markdown.content).includes("【长任务处理中，请勿打断，已用时"),
      ),
    ).toHaveLength(2);
  });

  it("repeats the expired-stream background status on the quiet cadence until the final arrives", async () => {
    const expiredError = {
      headers: { req_id: "req-recurring-background-status" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
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
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();

    const backgroundPushes = () =>
      mockClient.sendMessage.mock.calls.filter((call) =>
        String((call[1] as any).markdown.content).includes("【长任务处理中，请勿打断，已用时"),
      );
    expect(backgroundPushes()).toHaveLength(1);
    expect(String((backgroundPushes()[0]?.[1] as any).markdown.content)).toBe(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(backgroundPushes()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await flushPromises();
    expect(backgroundPushes()).toHaveLength(2);
    expect(String((backgroundPushes()[1]?.[1] as any).markdown.content)).toBe(
      "【长任务处理中，请勿打断，已用时13m00s】",
    );

    await handle.deliver({ text: "最终结果", isReasoning: false }, { kind: "final" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flushPromises();
    expect(backgroundPushes()).toHaveLength(2);
  });

  it("retries the recurring background status on the next quiet slot after a push failure", async () => {
    const expiredError = {
      headers: { req_id: "req-recurring-status-retry" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
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
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(String((mockClient.sendMessage.mock.calls[1]?.[1] as any).markdown.content)).toBe(
      "【长任务处理中，请勿打断，已用时13m00s】",
    );
    expect(onFail).not.toHaveBeenCalled();
  });

  it("defers but does not retire recurring status after external activity", async () => {
    const expiredError = {
      headers: { req_id: "req-recurring-status-external-activity" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    let releaseStatusPush: (() => void) | undefined;
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
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    handle.markExternalActivity?.();
    releaseStatusPush?.();
    await flushPromises();
    // Nothing piles onto the message that just reached the user, and the
    // in-flight push must not arm a second timer on top of the deferred one.
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    // The turn is still running, so the cadence has to come back — retiring it
    // here silenced the whole long task after one spawned-task completion.
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(3);
  });

  it.each(["final", "supersede"] as const)(
    "does not send later chunks from an in-flight background notice after %s",
    async (outcome) => {
      const expiredError = {
        headers: { req_id: `req-in-flight-status-${outcome}` },
        errcode: 846608,
        errmsg: "stream message update expired (>6 minutes), cannot update",
      };
      let releaseInFlightStatusChunk!: (value: unknown) => void;
      mockClient.replyStream.mockRejectedValueOnce(expiredError);
      mockClient.sendMessage
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseInFlightStatusChunk = resolve;
            }),
        )
        .mockResolvedValue({} as any);
      const handle = createBotWsReplyHandle({
        client: mockClient,
        frame: {
          headers: { req_id: `req-in-flight-status-${outcome}` },
          body: { from: { userid: "alice" }, chattype: "single" },
        } as unknown as ReplyHandleParams["frame"],
        accountId: "default",
        inboundKind: "text",
        autoSendPlaceholder: false,
      });

      await vi.advanceTimersByTimeAsync(8 * 60_000);
      await handle.deliver(
        {
          text: "旧任务进度。".repeat(900),
          channelData: { openclawProgressKind: "preamble" },
        },
        { kind: "block" },
      );
      await flushPromises();
      expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
      expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

      if (outcome === "final") {
        await handle.deliver({ text: "最终答案" }, { kind: "final" });
        expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
        expect(String((mockClient.sendMessage.mock.calls[1]?.[1] as any).markdown.content)).toContain(
          "最终答案",
        );
      } else {
        handle.supersedeByNewInbound?.({
          accountId: "default",
          peerKind: "direct",
          peerId: "alice",
          reason: "new-inbound",
        });
      }

      releaseInFlightStatusChunk({});
      await flushPromises();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      expect(mockClient.sendMessage).toHaveBeenCalledTimes(outcome === "final" ? 2 : 1);
    },
  );

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
    await vi.advanceTimersByTimeAsync(60_000);
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
        String((call[1] as any).markdown.content).includes("【长任务处理中，请勿打断，已用时"),
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
    mockClient.replyStream.mockRejectedValue(expiredError);
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

    // Two previews, then — once the answer is out as a push — a best-effort
    // finish frame that closes the bubble on the text it already shows, so it
    // does not sit open ("generating") above an answer that says 回复完毕.
    expect(mockClient.replyStream).toHaveBeenCalledTimes(3);
    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      "已经显示的前半段",
      true,
    );
    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      chat_type: 1,
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
    // The final never touches the stream while the ACK is pending; the only
    // stream write is the best-effort finish frame queued after the push, on
    // the text the bubble already shows.
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "已经显示的前半段",
      true,
    );
    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown",
      chat_type: 1,
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
      chat_type: 1,
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
      chat_type: 1,
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
      chat_type: 1,
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
      chat_type: 1,
      markdown: { content: `最终回复\n\n${FINAL_COMPLETION_MARKER}` },
    });
    expect(onDeliver).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed task's push text identical across its retry", async () => {
    // The fallback text IS the retry identity: a re-derived elapsed value would
    // reset the tracked chunk progress and re-push confirmed chunks.
    const expiredError = {
      headers: { req_id: "req-failure-context-identity" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    // A real push attempt burns seconds before it fails, which is exactly the
    // window a re-derived elapsed value would drift across.
    mockClient.sendMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("active push failed")), 3_000);
        }) as any,
    );

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-failure-context-identity" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    const delivery = handle.deliver(
      { text: "LLM request failed.", isError: true },
      { kind: "final" },
    );
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3_500);
    await delivery;
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
    const firstPush = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(firstPush).toContain("本次任务未完成");
    expect(firstPush).toContain("LLM request failed.");

    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();

    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(String((mockClient.sendMessage.mock.calls[1]?.[1] as any).markdown.content)).toBe(
      firstPush,
    );
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
      chat_type: 1,
      markdown: { content: "旧任务合并结果" },
    });
    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(onDeliver).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying an undelivered final until it lands, even after a successor replied", async () => {
    const expiredError = {
      headers: { req_id: "req-old-undelivered-retry" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    const pushError = Object.assign(new Error("active push rejected"), { errcode: 95001 });
    mockClient.replyStream.mockRejectedValueOnce(expiredError).mockResolvedValue({} as any);
    mockClient.sendMessage
      .mockRejectedValueOnce(pushError)
      .mockRejectedValueOnce(pushError)
      .mockRejectedValueOnce(pushError)
      .mockRejectedValueOnce(pushError)
      .mockResolvedValue({} as any);

    const oldHandle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-old-undelivered-retry" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    await oldHandle.deliver({ text: "旧任务最终结果" }, { kind: "final" });
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    const successor = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-successor-after-retry" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    await successor.deliver({ text: "新任务正常完成" }, { kind: "final" });

    await vi.advanceTimersByTimeAsync(200_000);
    await flushPromises();

    // The old answer was never delivered, so it must not be thrown away just
    // because the successor replied first — late beats lost.
    expect(
      mockClient.sendMessage.mock.calls.some((call) =>
        String((call[1] as any).markdown.content).includes("旧任务最终结果"),
      ),
    ).toBe(true);
    // Still bounded: the ladder stops at FINAL_PUSH_MAX_RETRIES.
    expect(mockClient.sendMessage.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("retires a deferred reply before it is activated", () => {
    const ownerId = "owner-retired-before-activation";
    registerBotWsReplyOwner(ownerId);
    const transportRetired = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-owner-retired-before-activation" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      deferActivation: true,
      runtimeOwnerId: ownerId,
    });
    handle.onTransportRetired?.(transportRetired);

    retireBotWsReplyOwner(ownerId);

    expect(transportRetired).toHaveBeenCalledOnce();
    expect(mockClient.replyStream).not.toHaveBeenCalled();
  });

  it("releases owner tracking after a superseded dispatch settles without background work", async () => {
    const ownerId = "owner-settled-supersede";
    registerBotWsReplyOwner(ownerId);
    const transportRetired = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-owner-settled-supersede" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      runtimeOwnerId: ownerId,
    });
    handle.onTransportRetired?.(transportRetired);
    handle.activate?.();
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });

    handle.markDispatchSettled?.();
    retireBotWsReplyOwner(ownerId);
    await flushPromises();

    expect(transportRetired).not.toHaveBeenCalled();
  });

  it("keeps owner tracking until dispatch settlement after a final retry completes", async () => {
    const ownerId = "owner-retry-before-dispatch-settlement";
    registerBotWsReplyOwner(ownerId);
    const transportRetired = vi.fn();
    mockClient.replyStream.mockRejectedValueOnce({
      errcode: 846608,
      errmsg: "stream message update expired",
    });
    mockClient.sendMessage
      .mockRejectedValueOnce(new Error("initial push failed"))
      .mockResolvedValueOnce({} as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-owner-retry-before-dispatch-settlement" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      runtimeOwnerId: ownerId,
    });
    handle.onTransportRetired?.(transportRetired);
    handle.activate?.();

    await handle.deliver({ text: "最终答案" }, { kind: "final" });
    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);

    retireBotWsReplyOwner(ownerId);
    expect(transportRetired).toHaveBeenCalledOnce();
  });

  it("does not send an old final through a replacement owner's push handle", async () => {
    const ownerId = "owner-overlapped-by-replacement";
    registerBotWsReplyOwner(ownerId);
    const expiredError = {
      errcode: 846608,
      errmsg: "stream message update expired",
    };
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const replacementSend = vi.fn().mockResolvedValue(undefined);
    registerBotWsPushHandle("default", {
      ownerId: "replacement-owner",
      isConnected: () => true,
      sendMarkdown: replacementSend,
      replyCommand: vi.fn(),
      sendMedia: vi.fn(),
    } as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-owner-overlapped-by-replacement" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      runtimeOwnerId: ownerId,
    });
    handle.activate?.();

    await handle.deliver({ text: "旧连接的最终答案" }, { kind: "final" });

    expect(replacementSend).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledOnce();
  });

  it("does not fall back through a replacement connection after its owner retires during ack wait", async () => {
    const ownerId = "owner-retired-during-ack-wait";
    registerBotWsReplyOwner(ownerId);
    const pendingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
    };
    pendingClient.hasPendingReplyAck = vi.fn(() => true);
    const replacementSend = vi.fn().mockResolvedValue(undefined);
    const handle = createBotWsReplyHandle({
      client: pendingClient,
      frame: {
        headers: { req_id: "req-owner-retired-during-ack-wait" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      runtimeOwnerId: ownerId,
    });
    handle.activate?.();

    const delivery = handle.deliver({ text: "旧连接的最终答案" }, { kind: "final" });
    await flushPromises();
    expect(pendingClient.hasPendingReplyAck).toHaveBeenCalled();

    retireBotWsReplyOwner(ownerId);
    registerBotWsPushHandle("default", {
      isConnected: () => true,
      sendMarkdown: replacementSend,
      replyCommand: vi.fn(),
      sendMedia: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(5_500);
    await delivery;

    expect(replacementSend).not.toHaveBeenCalled();
    expect(mockClient.replyStream).not.toHaveBeenCalled();
  });

  it("does not run an old final retry through a replacement connection before owner retirement", async () => {
    const ownerId = "owner-retry-before-retirement";
    const expiredError = {
      headers: { req_id: "req-owner-retry-before-retirement" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    const oldSend = vi.fn().mockRejectedValueOnce(new Error("old push failed"));
    const replacementSend = vi.fn().mockResolvedValue(undefined);
    registerBotWsReplyOwner(ownerId);
    registerBotWsPushHandle(
      "default",
      {
        ownerId,
        isConnected: () => true,
        sendMarkdown: oldSend,
        replyCommand: vi.fn(),
        sendMedia: vi.fn(),
      } as any,
    );
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const onDeliver = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-owner-retry-before-retirement" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      runtimeOwnerId: ownerId,
      onDeliver,
    });

    await handle.deliver({ text: "旧连接最终结果" }, { kind: "final" });
    expect(oldSend).toHaveBeenCalledOnce();

    registerBotWsPushHandle(
      "default",
      {
        ownerId: "replacement-owner",
        isConnected: () => true,
        sendMarkdown: replacementSend,
        replyCommand: vi.fn(),
        sendMedia: vi.fn(),
      } as any,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();

    expect(replacementSend).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledOnce();
    expect(onDeliver).toHaveBeenCalledOnce();
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

    // Freeze by size, then let the first eight-minute status refresh die terminally.
    await handle.deliver({ text: "预览内容。".repeat(620), isReasoning: false }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(8 * 60_000);
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
    await vi.advanceTimersByTimeAsync(8 * 60_000 + 130_000);
    await flushPromises();
    const callsBeforeCap = mockClient.replyStream.mock.calls.length;
    expect(callsBeforeCap).toBeGreaterThan(2);

    // Jump wall time to the lifetime cap without executing every 60s refresh.
    vi.setSystemTime(Date.now() + 3_600_000);
    await vi.advanceTimersByTimeAsync(60_000);
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
    mockClient.replyStream.mockRejectedValue(expiredError);
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
    await vi.advanceTimersByTimeAsync(8 * 60_000);
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

  it("renders OpenClaw narration as transient progress without merging it into the final", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-transient-preamble" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      {
        text: "正在检查仓库",
        channelData: {
          openclawProgressKind: "preamble",
          openclawProgressSteps: ["正在检查仓库"],
          openclawProgressDroppedSteps: 0,
        },
      },
      { kind: "block" },
    );
    expect(String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "")).toBe(
      "1）正在检查仓库",
    );

    // The next step appends to the numbered log instead of overwriting it.
    await handle.deliver(
      {
        text: "正在检查仓库\n仓库检查完成，正在生成整改方案",
        channelData: {
          openclawProgressKind: "preamble",
          openclawProgressSteps: ["正在检查仓库", "仓库检查完成，正在生成整改方案"],
          openclawProgressDroppedSteps: 0,
        },
      },
      { kind: "block" },
    );
    expect(String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "")).toBe(
      "1）正在检查仓库\n2）仓库检查完成，正在生成整改方案",
    );

    await handle.deliver({ text: "最终答案" }, { kind: "final" });
    const finalText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalText).toContain("最终答案");
    expect(finalText).not.toContain("正在检查仓库");
    expect(finalText).not.toContain("正在生成整改方案");
  });

  it("keeps OpenClaw progress visible when a req-id collision forces active push", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-collision-active-push" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "file",
      forceActivePush: true,
    });
    await flushPromises();

    await handle.deliver(
      {
        text: "正在执行仓库检查",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
    expect(mockClient.replyStream).not.toHaveBeenCalled();
    const immediateProgressPush = String(
      (mockClient.sendMessage.mock.calls.at(-1)?.[1] as any)?.markdown?.content ?? "",
    );
    expect(immediateProgressPush).toContain("正在执行仓库检查");

    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();
    const statusPush = String(
      (mockClient.sendMessage.mock.calls.at(-1)?.[1] as any)?.markdown?.content ?? "",
    );
    expect(statusPush).toContain("【长任务处理中，请勿打断，已用时8m00s】");

    await handle.deliver({ text: "最终答案" }, { kind: "final" });
    await flushPromises();
    const finalPush = String(
      (mockClient.sendMessage.mock.calls.at(-1)?.[1] as any)?.markdown?.content ?? "",
    );
    expect(finalPush).toContain("最终答案");
    expect(finalPush).not.toContain("正在执行仓库检查");
    expect(mockClient.replyStream).not.toHaveBeenCalled();
  });

  it("latches callback ownership loss across progress and final delivery", async () => {
    let callbackStreamCurrent = true;
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-dynamic-ownership" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      isCallbackStreamCurrent: () => callbackStreamCurrent,
    });

    await handle.deliver(
      {
        text: "正在执行仓库检查",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();

    callbackStreamCurrent = false;
    mockClient.replyStream.mockClear();
    await handle.deliver(
      {
        text: "仓库检查完成",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(String((mockClient.sendMessage.mock.calls.at(-1)?.[1] as any)?.markdown?.content)).toContain(
      "仓库检查完成",
    );

    // Ownership loss is one-way even if a stale checker later reports true.
    callbackStreamCurrent = true;
    mockClient.replyStream.mockClear();
    await handle.deliver({ text: "最终答案" }, { kind: "final" });
    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(String((mockClient.sendMessage.mock.calls.at(-1)?.[1] as any)?.markdown?.content)).toContain(
      "最终答案",
    );
  });

  it("moves a scheduled heartbeat to active push after callback ownership expires", async () => {
    let callbackStreamCurrent = true;
    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-dynamic-heartbeat" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      isCallbackStreamCurrent: () => callbackStreamCurrent,
    });
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    callbackStreamCurrent = false;
    mockClient.replyStream.mockClear();
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();

    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(String((mockClient.sendMessage.mock.calls.at(-1)?.[1] as any)?.markdown?.content)).toContain(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );
  });

  it("actively pushes failure after callback ownership is lost", async () => {
    let callbackStreamCurrent = true;
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-dynamic-failure" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      isCallbackStreamCurrent: () => callbackStreamCurrent,
    });

    callbackStreamCurrent = false;
    await handle.fail(new Error("dynamic ownership failed"));

    expect(mockClient.replyStream).not.toHaveBeenCalled();
    const failurePush = String(
      (mockClient.sendMessage.mock.calls.at(-1)?.[1] as any)?.markdown?.content ?? "",
    );
    expect(failurePush).toContain("本次回复投递中断");
    expect(failurePush).not.toContain("dynamic ownership failed");
  });

  it("rechecks callback ownership after waiting for a pending final ACK", async () => {
    let callbackStreamCurrent = true;
    let pendingAck = true;
    const pendingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
    };
    pendingClient.hasPendingReplyAck = vi.fn(() => pendingAck);
    const handle = createBotWsReplyHandle({
      client: pendingClient,
      frame: {
        headers: { req_id: "req-ownership-during-ack-wait" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      isCallbackStreamCurrent: () => callbackStreamCurrent,
    });

    const finalPromise = handle.deliver({ text: "等待期间的最终答案" }, { kind: "final" });
    await flushPromises();
    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).not.toHaveBeenCalled();

    callbackStreamCurrent = false;
    pendingAck = false;
    await vi.advanceTimersByTimeAsync(100);
    await finalPromise;

    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(String((mockClient.sendMessage.mock.calls.at(-1)?.[1] as any)?.markdown?.content)).toContain(
      "等待期间的最终答案",
    );
  });

  it("does not advance body bookmarks from a late preview after ownership loss", async () => {
    let callbackStreamCurrent = true;
    let resolveLatePreview!: (value: unknown) => void;
    mockClient.replyStream.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLatePreview = resolve;
        }) as any,
    );
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-late-preview-ownership-loss" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      isCallbackStreamCurrent: () => callbackStreamCurrent,
    });

    const blockPromise = handle.deliver({ text: "必须保留的正文。" }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(8_000);
    await blockPromise;

    callbackStreamCurrent = false;
    resolveLatePreview({});
    await flushPromises();
    mockClient.replyStream.mockClear();
    mockClient.sendMessage.mockClear();
    await handle.deliver({ text: "最终结论。" }, { kind: "final" });

    expect(mockClient.replyStream).not.toHaveBeenCalled();
    const finalPush = String(
      (mockClient.sendMessage.mock.calls.at(-1)?.[1] as any)?.markdown?.content ?? "",
    );
    expect(finalPush).toContain("必须保留的正文。");
    expect(finalPush).toContain("最终结论。");
  });

  it("does not let transient preamble reset the delivered-body bookmark", async () => {
    const expiredError = {
      headers: { req_id: "req-preamble-after-body-expired" },
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
        headers: { req_id: "req-preamble-after-body-expired" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "用户已经看见的正文" }, { kind: "block" });
    await handle.deliver(
      {
        text: "正在整理最终结果",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
    await handle.deliver(
      { text: "用户已经看见的正文\n最终新增内容" },
      { kind: "final" },
    );

    const pushed = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    ).join("\n");
    expect(pushed).toContain("最终新增内容");
    expect(pushed).not.toContain("用户已经看见的正文");
    expect(pushed).not.toContain("正在整理最终结果");
  });

  it("re-sends body text replaced by a near-limit preamble before stream expiry", async () => {
    const expiredError = {
      headers: { req_id: "req-preamble-replaced-body-expired" },
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
        headers: { req_id: "req-preamble-replaced-body-expired" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const bodyText = "此前已经显示、但随后被过程帧覆盖的正文";

    await handle.deliver({ text: bodyText }, { kind: "block" });
    await handle.deliver(
      {
        text: "P".repeat(3_499),
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
    const preambleFrame = String(mockClient.replyStream.mock.calls[1]?.[2] ?? "");
    expect(preambleFrame).not.toContain(bodyText);

    await handle.deliver({ text: `${bodyText}\n最终新增内容` }, { kind: "final" });

    const pushed = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    ).join("\n");
    expect(pushed).toContain(bodyText);
    expect(pushed).toContain("最终新增内容");
    expect(pushed).not.toContain("P".repeat(100));
  });

  it("keeps a pending body's bookmark when preamble replaces the queued preview", async () => {
    const expiredError = {
      headers: { req_id: "req-pending-body-preamble-expired" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    let pendingAck = true;
    const pendingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    pendingClient.hasPendingReplyAck = vi.fn(() => pendingAck);
    pendingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const handle = createBotWsReplyHandle({
      client: pendingClient,
      frame: {
        headers: { req_id: "req-pending-body-preamble-expired" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "用户已经看见的正文" }, { kind: "block" });
    await handle.deliver(
      {
        text: "正在整理最终结果",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
    expect(pendingClient.replyStreamNonBlocking).not.toHaveBeenCalled();

    pendingAck = false;
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    expect(String(pendingClient.replyStreamNonBlocking.mock.calls[0]?.[2] ?? "")).toContain(
      "用户已经看见的正文",
    );

    await handle.deliver(
      { text: "用户已经看见的正文\n最终新增内容" },
      { kind: "final" },
    );

    const pushed = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    ).join("\n");
    expect(pushed).toContain("最终新增内容");
    expect(pushed).not.toContain("用户已经看见的正文");
    expect(pushed).not.toContain("正在整理最终结果");
  });

  it("treats a pending body carried by preamble as visible when superseded", async () => {
    let pendingAck = true;
    const pendingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    pendingClient.hasPendingReplyAck = vi.fn(() => pendingAck);
    pendingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({} as any);
    const handle = createBotWsReplyHandle({
      client: pendingClient,
      frame: {
        headers: { req_id: "req-pending-body-preamble-superseded" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "已经显示的旧任务正文" }, { kind: "block" });
    await handle.deliver(
      {
        text: "正在继续旧任务",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
    pendingAck = false;
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    await handle.deliver(
      { text: "已经显示的旧任务正文\n不应复活的旧任务结论" },
      { kind: "final" },
    );

    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps a near-limit preamble preview within the hard frame budget", async () => {
    const expiredError = {
      headers: { req_id: "req-near-limit-preamble" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    let pendingAck = true;
    const pendingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    pendingClient.hasPendingReplyAck = vi.fn(() => pendingAck);
    pendingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const handle = createBotWsReplyHandle({
      client: pendingClient,
      frame: {
        headers: { req_id: "req-near-limit-preamble" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const bodyText = `${"正文片段".repeat(80)}正文尾部`;

    await handle.deliver({ text: bodyText }, { kind: "block" });
    await handle.deliver(
      {
        text: "P".repeat(3_450),
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
    pendingAck = false;
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    const preview = String(pendingClient.replyStreamNonBlocking.mock.calls[0]?.[2] ?? "");
    expect(preview.length).toBeLessThanOrEqual(3_500);
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(15_360);

    await handle.deliver({ text: `${bodyText}\n最终新增内容` }, { kind: "final" });
    const pushed = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    ).join("\n");
    expect(pushed).toContain("正文尾部");
    expect(pushed).toContain("最终新增内容");
    expect(pushed).not.toContain("P".repeat(100));
  });

  it("keeps literal think tags in a near-limit preamble within the final wire budget", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-near-limit-literal-think-preamble" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      {
        text: Array.from({ length: 400 }, () => "`<think>`").join("\n"),
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );

    const preview = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(preview).toContain("&lt;think&gt;");
    expect(preview.length).toBeLessThanOrEqual(3_500);
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(15_360);
  });

  it("keeps the body bookmark when preamble markup renders empty", async () => {
    const expiredError = {
      headers: { req_id: "req-empty-rendered-preamble" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    let pendingAck = true;
    const pendingClient = mockClient as typeof mockClient & {
      hasPendingReplyAck: ReturnType<typeof vi.fn>;
      replyStreamNonBlocking: ReturnType<typeof vi.fn>;
    };
    pendingClient.hasPendingReplyAck = vi.fn(() => pendingAck);
    pendingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({} as any);
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    const handle = createBotWsReplyHandle({
      client: pendingClient,
      frame: {
        headers: { req_id: "req-empty-rendered-preamble" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "已经显示的正文" }, { kind: "block" });
    await handle.deliver(
      {
        text: "<span></span>",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
    pendingAck = false;
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    expect(String(pendingClient.replyStreamNonBlocking.mock.calls[0]?.[2] ?? "")).toContain(
      "已经显示的正文",
    );

    await handle.deliver(
      { text: "已经显示的正文\n最终新增内容" },
      { kind: "final" },
    );
    const pushed = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    ).join("\n");
    expect(pushed).toContain("最终新增内容");
    expect(pushed).not.toContain("已经显示的正文");
  });

  it("still delivers a superseded turn's real final after preamble-only progress", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-preamble-superseded-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    await handle.deliver(
      {
        text: "正在执行旧任务",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
    );
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });

    await handle.deliver({ text: "旧任务仍有真实最终答案" }, { kind: "final" });

    const pushed = mockClient.sendMessage.mock.calls.map((call) =>
      String((call[1] as any).markdown.content),
    ).join("\n");
    expect(pushed).toContain("旧任务仍有真实最终答案");
    expect(pushed).not.toContain("正在执行旧任务");
  });

  it.each([
    [
      "preamble",
      {
        text: "正在检查仓库",
        channelData: { openclawProgressKind: "preamble" },
      },
    ],
    ["reasoning", { text: "正在分析依赖", isReasoning: true }],
  ])("keeps the eight-minute status gate alive after %s progress", async (_label, payload) => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: `req-status-after-${_label}` },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
    });
    await flushPromises();
    await handle.deliver(payload, { kind: "block" });
    const callsAfterProgress = mockClient.replyStream.mock.calls.length;

    await vi.advanceTimersByTimeAsync(8 * 60_000 - 1);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(callsAfterProgress);

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(callsAfterProgress + 1);
    const eightMinuteHeartbeat = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(eightMinuteHeartbeat).toContain(String(payload.text));
    expect(eightMinuteHeartbeat).toContain("【长任务处理中，请勿打断，已用时8m00s】");

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    const repeatedHeartbeat = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(repeatedHeartbeat).toContain(String(payload.text));
    expect(repeatedHeartbeat).toContain("【长任务处理中，请勿打断，已用时9m00s】");
  });

  it("uses only the frozen-body lane for status once visible body has frozen", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-single-status-lane" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
    });
    await flushPromises();
    await handle.deliver({ text: "正文进度。".repeat(700) }, { kind: "block" });
    const callsBeforeGate = mockClient.replyStream.mock.calls.length;

    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(callsBeforeGate + 1);
    expect(String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "")).toContain(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(callsBeforeGate + 2);
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

    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await flushPromises();

    // Without the self-healing interval start, the skipped freezing send
    // would leave the status counter dead until the next block event.
    expect(nonBlockingClient.replyStreamNonBlocking.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastCall = nonBlockingClient.replyStreamNonBlocking.mock.calls.at(-1);
    expect(String(lastCall?.[2])).toContain("预览内容");
    expect(String(lastCall?.[2])).toContain(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(String(nonBlockingClient.replyStreamNonBlocking.mock.calls.at(-1)?.[2])).toContain(
      "【长任务处理中，请勿打断，已用时9m00s】",
    );
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
      chat_type: 1,
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
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
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

    const finalText = `HEAD-MARK${"正文内容。".repeat(1_400)}TAIL-MARK`;
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
    runtime.setWecomRuntime({ config: { current: () => ({}) } } as any);
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

  it("delivers a final the user never received even after a new activation", async () => {
    // Reliability invariant: a real answer from OpenClaw must not be dropped.
    // The first push failed, so the user has seen NOTHING of this final; the
    // next message arriving on the peer must not destroy it.
    const pushError = Object.assign(new Error("push rejected"), { errcode: 95001 });
    const expiredError = {
      headers: { req_id: "req-undelivered-final" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.sendMessage.mockRejectedValueOnce(pushError);
    mockClient.sendMessage.mockResolvedValue({} as any);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-undelivered-final" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "预览片段", isReasoning: false }, { kind: "block" });
    await flushPromises();
    mockClient.replyStream.mockRejectedValueOnce(expiredError);
    await handle.deliver({ text: "迟到的完整答案", isReasoning: false }, { kind: "final" });
    await flushPromises();

    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-undelivered-final-next" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    }).activate?.();

    await vi.advanceTimersByTimeAsync(20_000);
    await drainChunkTimers();

    expect(
      mockClient.sendMessage.mock.calls.filter((call) =>
        String((call[1] as any).markdown.content).includes("迟到的完整答案"),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("does not re-push a final the user already partially received", async () => {
    // The other half of the invariant: once a chunk of THIS push is confirmed
    // delivered, a retry would duplicate what the user already has, so a newer
    // activation may retire it.
    const pushError = Object.assign(new Error("push rejected"), { errcode: 95001 });
    const expiredError = {
      headers: { req_id: "req-partial-received" },
      errcode: 846608,
      errmsg: "stream message update expired (>6 minutes), cannot update",
    };
    mockClient.replyStream.mockRejectedValueOnce(expiredError).mockResolvedValue({} as any);
    // Chunk 1 lands, chunk 2 fails: delivered > 0.
    mockClient.sendMessage.mockResolvedValueOnce({} as any).mockRejectedValue(pushError);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-partial-received" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    // The chunk loop sleeps 800 ms between sends, so the delivery only settles
    // once the simulated clock moves.
    const delivery = handle.deliver({ text: "长答案。".repeat(1_200) }, { kind: "final" });
    await drainChunkTimers();
    await delivery;
    const deliveredBefore = mockClient.sendMessage.mock.calls.length;
    expect(deliveredBefore).toBeGreaterThanOrEqual(2);

    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-partial-received-next" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    }).activate?.();

    await vi.advanceTimersByTimeAsync(200_000);
    await drainChunkTimers();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(deliveredBefore);
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

  it("closes a superseded placeholder after its in-flight ack settles", async () => {
    let resolvePlaceholder!: (value: unknown) => void;
    mockClient.replyStream
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePlaceholder = resolve;
          }),
      )
      .mockResolvedValue({} as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-supersede-placeholder-in-flight" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });
    await flushPromises();

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    resolvePlaceholder({});
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.replyStream.mock.calls[1]?.[2]).toBe("已收到新消息，合并思考。✅");
    expect(mockClient.replyStream.mock.calls[1]?.[3]).toBe(true);
  });

  it.each(["new-inbound", "new-inbound-unmerged"] as const)(
    "does not rearm a lost-ACK placeholder after %s supersedes it",
    async (reason) => {
      let rejectPlaceholder!: (error: unknown) => void;
      mockClient.replyStream
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectPlaceholder = reject;
            }),
        )
        .mockResolvedValue({} as any);
      const handle = createBotWsReplyHandle({
        client: mockClient,
        frame: {
          headers: { req_id: `req-lost-ack-${reason}` },
          body: { from: { userid: "alice" }, chattype: "single" },
        } as unknown as ReplyHandleParams["frame"],
        accountId: "default",
        inboundKind: "file",
        placeholderContent: "正在思考...",
      });
      await flushPromises();

      handle.supersedeByNewInbound?.({
        accountId: "default",
        peerKind: "direct",
        peerId: "alice",
        reason,
      });
      rejectPlaceholder(
        new Error(`Reply ack timeout (5000ms) for reqId: req-lost-ack-${reason}`),
      );
      await flushPromises();
      await vi.advanceTimersByTimeAsync(3_100);
      await flushPromises();

      expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
      expect(mockClient.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("tells an unmergeable superseded inbound that it was not processed", async () => {
    // A pending inbound that could not be folded into its successor (another
    // group member, an event turn) never reaches OpenClaw, so promising the
    // user it was merged hides the loss.
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-supersede-unmerged" },
        body: { from: { userid: "alice" }, chattype: "group", chatid: "room-1" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });
    await flushPromises();

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "group",
      peerId: "room-1",
      reason: "new-inbound-unmerged",
    });
    await flushPromises();

    const noticeCall = mockClient.replyStream.mock.calls.at(-1);
    expect(String(noticeCall?.[2] ?? "")).toContain("尚未开始处理");
    expect(noticeCall?.[3]).toBe(true);
  });

  it("closes a superseded block preview after its in-flight ack settles", async () => {
    let resolvePreview!: (value: unknown) => void;
    mockClient.replyStream
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePreview = resolve;
          }),
      )
      .mockResolvedValue({} as any);
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-supersede-preview-in-flight" },
        body: { from: { userid: "alice" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const previewDelivery = handle.deliver({ text: "已完成一半" }, { kind: "block" });
    await flushPromises();

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    resolvePreview({});
    await previewDelivery;
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.replyStream.mock.calls[1]?.[2]).toBe("已收到新消息，合并思考。✅");
    expect(mockClient.replyStream.mock.calls[1]?.[3]).toBe(true);
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
      chat_type: 1,
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
      chat_type: 1,
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
      chat_type: 1,
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
      chat_type: 1,
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

  it("delivers identical finals for distinct forced-push handles without weakening per-handle dedup", async () => {
    const createForcedHandle = () =>
      createBotWsReplyHandle({
        client: mockClient,
        frame: {
          headers: { req_id: "req-identical-forced-final" },
          body: { from: { userid: "alice" }, chattype: "single" },
        } as unknown as ReplyHandleParams["frame"],
        accountId: "default",
        inboundKind: "text",
        autoSendPlaceholder: false,
        forceActivePush: true,
      });
    const firstHandle = createForcedHandle();
    const secondHandle = createForcedHandle();
    const finalPayload = { text: "合法的 forced-push 相同答案", isReasoning: false };

    await firstHandle.deliver(finalPayload, { kind: "final" });
    await firstHandle.deliver(finalPayload, { kind: "final" });
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    await secondHandle.deliver(finalPayload, { kind: "final" });

    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
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
      chat_type: 1,
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

  it("uses active push for a welcome final when the callback req_id is unsafe", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "welcome_collision_req" },
        body: { chattype: "single", from: { userid: "bob" } },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "welcome",
      forceActivePush: true,
    });

    await handle.deliver({ text: "Hello Bob" }, { kind: "final" });

    expect(mockClient.replyWelcome).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledWith(
      "bob",
      expect.objectContaining({
        msgtype: "markdown",
        markdown: expect.objectContaining({ content: expect.stringContaining("Hello Bob") }),
      }),
    );
  });

  it("uses active push when a welcome loses callback ownership after creation", async () => {
    let callbackStreamCurrent = true;
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "welcome_dynamic_ownership_req" },
        body: { chattype: "single", from: { userid: "bob" } },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "welcome",
      isCallbackStreamCurrent: () => callbackStreamCurrent,
    });

    callbackStreamCurrent = false;
    await handle.deliver({ text: "Hello after ownership loss" }, { kind: "final" });

    expect(mockClient.replyWelcome).not.toHaveBeenCalled();
    expect(String((mockClient.sendMessage.mock.calls.at(-1)?.[1] as any)?.markdown?.content)).toContain(
      "Hello after ownership loss",
    );
  });

  it("uses active push for a welcome failure when the callback req_id is unsafe", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "welcome_failure_collision_req" },
        body: { chattype: "single", from: { userid: "bob" } },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "welcome",
      forceActivePush: true,
    });

    await handle.fail(new Error("welcome failed"));

    expect(mockClient.replyWelcome).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledWith(
      "bob",
      expect.objectContaining({
        msgtype: "markdown",
        markdown: expect.objectContaining({ content: expect.stringContaining("welcome failed") }),
      }),
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
