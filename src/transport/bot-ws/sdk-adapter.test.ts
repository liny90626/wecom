import { afterEach, describe, expect, it, vi } from "vitest";

const sdkMockState = vi.hoisted(() => {
  class MockWSClient {
    readonly handlers = new Map<string, Array<(payload: any) => void>>();
    readonly isConnected = true;
    readonly replyStream = vi.fn().mockResolvedValue(undefined);
    readonly replyWelcome = vi.fn().mockResolvedValue(undefined);
    readonly sendMessage = vi.fn().mockResolvedValue(undefined);
    readonly reply = vi.fn().mockResolvedValue(undefined);

    constructor(_options: unknown) {
      sdkMockState.client = this;
    }

    on(event: string, handler: (payload: any) => void): void {
      const current = this.handlers.get(event) ?? [];
      current.push(handler);
      this.handlers.set(event, current);
    }

    emit(event: string, payload: any): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(payload);
      }
    }

    connectCalls = 0;

    connect(): void {
      this.connectCalls += 1;
    }

    disconnect(): void {}
  }

  return {
    client: null as InstanceType<typeof MockWSClient> | null,
    MockWSClient,
  };
});

vi.mock("@wecom/aibot-node-sdk", () => ({
  default: {
    WSClient: sdkMockState.MockWSClient,
  },
  WSClient: sdkMockState.MockWSClient,
  generateReqId: (prefix: string) => `${prefix}-1`,
}));

import { BotWsSdkAdapter } from "./sdk-adapter.js";
import { getBotWsPushHandle, unregisterBotWsPushHandle } from "../../app/index.js";
import { WecomGatewaySim } from "../../test-utils/wecom-gateway-sim.js";

const waitForAsyncCallbacks = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("BotWsSdkAdapter", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  afterEach(() => {
    vi.useRealTimers();
    const pushHandle = getBotWsPushHandle("acc-1");
    if (pushHandle) unregisterBotWsPushHandle("acc-1", pushHandle);
    process.off("unhandledRejection", onUnhandledRejection);
    unhandledRejections.length = 0;
    sdkMockState.client = null;
  });

  it("contains frame handler rejections instead of leaking unhandled rejections", async () => {
    vi.useFakeTimers();
    process.on("unhandledRejection", onUnhandledRejection);

    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: {
            botId: "bot-1",
            secret: "secret-1",
          },
          config: {},
        },
      },
      handleEvent: vi.fn().mockRejectedValue(new Error("frame exploded")),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const adapter = new BotWsSdkAdapter(runtime as any, log as any);
    adapter.start();

    sdkMockState.client?.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-1" },
      body: {
        msgid: "msg-1",
        msgtype: "text",
        from: { userid: "user-1" },
        text: { content: "hello" },
      },
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(runtime.handleEvent).toHaveBeenCalledTimes(1);
    expect(runtime.recordOperationalIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: "bot-ws",
        category: "runtime-error",
        messageId: "msg-1",
        error: "frame exploded",
      }),
    );
    expect(runtime.touchTransportSession).toHaveBeenCalledWith(
      "bot-ws",
      expect.objectContaining({
        lastError: "frame exploded",
      }),
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "frame handler failed account=acc-1 reqId=req-1 message=frame exploded",
      ),
    );
    expect(unhandledRejections).toHaveLength(0);
    adapter.stop();
    vi.useRealTimers();
  });

  it("does not send a placeholder until the runtime activates the reply handle", async () => {
    vi.useFakeTimers();
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn(async (_event, replyHandle) => {
        expect(sdkMockState.client?.replyStream).not.toHaveBeenCalled();
        replyHandle.activate?.();
      }),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };

    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);
    adapter.start();
    sdkMockState.client?.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-deferred" },
      body: {
        msgid: "msg-deferred",
        msgtype: "text",
        from: { userid: "user-1" },
        text: { content: "hello" },
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.handleEvent).toHaveBeenCalledOnce();
    expect(sdkMockState.client?.replyStream).toHaveBeenCalledOnce();
    adapter.stop();
    vi.useRealTimers();
  });

  it("routes a frame without req_id through active push", async () => {
    vi.useFakeTimers();
    let replyHandle: any;
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn(async (_event, handle) => {
        replyHandle = handle;
      }),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = { warn: vi.fn() };
    const adapter = new BotWsSdkAdapter(runtime as any, log as any);

    adapter.start();
    try {
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: {},
        body: {
          msgid: "msg-missing-req-id",
          msgtype: "text",
          chattype: "single",
          from: { userid: "user-missing-req-id" },
          text: { content: "hello" },
        },
      });
      await Promise.resolve();

      expect(replyHandle).toBeDefined();
      expect(
        log.warn.mock.calls.some(([message]) =>
          String(message).includes("reason=missing-req-id"),
        ),
      ).toBe(true);
      replyHandle.activate?.();
      sdkMockState.client?.replyStream.mockClear();
      sdkMockState.client?.sendMessage.mockClear();
      await replyHandle.deliver({ text: "missing req_id final" }, { kind: "final" });
      expect(sdkMockState.client?.replyStream).not.toHaveBeenCalled();
      expect(sdkMockState.client?.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      adapter.stop();
    }
  });

  it("keeps an unexpired req_id claim after more than 1,024 newer req_ids", async () => {
    vi.useFakeTimers();
    const replyHandles: any[] = [];
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn(async (_event, replyHandle) => {
        replyHandles.push(replyHandle);
      }),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = { warn: vi.fn() };
    const adapter = new BotWsSdkAdapter(runtime as any, log as any);
    const emitTextFrame = (reqId: string, messageId: string) => {
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: reqId },
        body: {
          msgid: messageId,
          msgtype: "text",
          chattype: "single",
          from: { userid: "user-claim-capacity" },
          text: { content: messageId },
        },
      });
    };

    adapter.start();
    try {
      emitTextFrame("req-protected", "msg-protected-first");
      for (let index = 0; index < 1_024; index += 1) {
        emitTextFrame(`req-filler-${index}`, `msg-filler-${index}`);
      }
      emitTextFrame("req-protected", "msg-protected-successor");
      await Promise.resolve();

      expect(runtime.handleEvent).toHaveBeenCalledTimes(1_026);
      expect(
        log.warn.mock.calls.some(([message]) => String(message).includes("reason=claim-capacity")),
      ).toBe(true);
      expect(
        log.warn.mock.calls.some(([message]) => String(message).includes("reason=req-id-collision")),
      ).toBe(true);
      const originalHandle = replyHandles[0];
      const overflowHandle = replyHandles.at(-2);
      const successorHandle = replyHandles.at(-1);
      expect(originalHandle).toBeDefined();
      expect(overflowHandle).toBeDefined();
      expect(successorHandle).toBeDefined();
      sdkMockState.client?.replyStream.mockClear();
      sdkMockState.client?.sendMessage.mockClear();

      overflowHandle.activate?.();
      await overflowHandle.deliver({ text: "overflow final" }, { kind: "final" });
      expect(sdkMockState.client?.replyStream).not.toHaveBeenCalled();
      expect(sdkMockState.client?.sendMessage).toHaveBeenCalledTimes(1);

      sdkMockState.client?.replyStream.mockClear();
      sdkMockState.client?.sendMessage.mockClear();
      successorHandle.activate?.();
      await successorHandle.deliver({ text: "successor final" }, { kind: "final" });
      expect(sdkMockState.client?.replyStream).not.toHaveBeenCalled();
      expect(sdkMockState.client?.sendMessage).toHaveBeenCalledTimes(1);

      emitTextFrame("req-protected", "msg-protected-successor");
      await Promise.resolve();
      const successorRedeliveryHandle = replyHandles.at(-1);
      sdkMockState.client?.replyStream.mockClear();
      sdkMockState.client?.sendMessage.mockClear();
      successorRedeliveryHandle.activate?.();
      await successorRedeliveryHandle.deliver(
        { text: "successor redelivery final" },
        { kind: "final" },
      );
      expect(sdkMockState.client?.replyStream).not.toHaveBeenCalled();
      expect(sdkMockState.client?.sendMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(8 * 60_000 + 1);
      emitTextFrame("req-protected", "msg-protected-after-expiry");
      await Promise.resolve();
      const afterExpiryHandle = replyHandles.at(-1);
      sdkMockState.client?.replyStream.mockClear();
      sdkMockState.client?.sendMessage.mockClear();
      afterExpiryHandle.activate?.();
      await vi.advanceTimersByTimeAsync(0);
      await afterExpiryHandle.deliver({ text: "after expiry final" }, { kind: "final" });
      expect(sdkMockState.client?.replyStream).toHaveBeenCalledTimes(2);
      expect(sdkMockState.client?.sendMessage).not.toHaveBeenCalled();

      sdkMockState.client?.replyStream.mockClear();
      sdkMockState.client?.sendMessage.mockClear();
      await originalHandle.deliver({ text: "original owner late final" }, { kind: "final" });
      expect(sdkMockState.client?.replyStream).not.toHaveBeenCalled();
      expect(sdkMockState.client?.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      adapter.stop();
    }
  });

  it("gives only the first handle callback ownership on exact message redelivery", async () => {
    vi.useFakeTimers();
    const replyHandles: any[] = [];
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn(async (_event, replyHandle) => {
        replyHandles.push(replyHandle);
      }),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = { warn: vi.fn() };
    const adapter = new BotWsSdkAdapter(runtime as any, log as any);
    const frame = {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-exact-redelivery" },
      body: {
        msgid: "msg-exact-redelivery",
        msgtype: "text",
        chattype: "single",
        from: { userid: "user-redelivery" },
        text: { content: "same message" },
      },
    };

    adapter.start();
    try {
      sdkMockState.client?.emit("message", frame);
      sdkMockState.client?.emit("message", frame);
      await Promise.resolve();

      expect(replyHandles).toHaveLength(2);
      expect(
        log.warn.mock.calls.some(([message]) => String(message).includes("reason=req-id-collision")),
      ).toBe(true);
      const [originalHandle, redeliveryHandle] = replyHandles;

      originalHandle.activate?.();
      await vi.advanceTimersByTimeAsync(0);
      sdkMockState.client?.replyStream.mockClear();
      sdkMockState.client?.sendMessage.mockClear();
      await originalHandle.deliver({ text: "identical final" }, { kind: "final" });
      expect(sdkMockState.client?.replyStream).toHaveBeenCalledTimes(1);
      expect(sdkMockState.client?.sendMessage).not.toHaveBeenCalled();

      sdkMockState.client?.replyStream.mockClear();
      sdkMockState.client?.sendMessage.mockClear();
      redeliveryHandle.activate?.();
      await redeliveryHandle.deliver({ text: "identical final" }, { kind: "final" });
      expect(sdkMockState.client?.replyStream).not.toHaveBeenCalled();
      expect(sdkMockState.client?.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      adapter.stop();
    }
  });

  it("does not reuse an expired req_id while an SDK ACK is still pending", async () => {
    vi.useFakeTimers();
    const replyHandles: any[] = [];
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn(async (_event, replyHandle) => {
        replyHandles.push(replyHandle);
      }),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = { warn: vi.fn() };
    const adapter = new BotWsSdkAdapter(runtime as any, log as any);
    const emitFrame = (messageId: string) => {
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-pending-at-expiry" },
        body: {
          msgid: messageId,
          msgtype: "text",
          chattype: "single",
          from: { userid: "user-pending-at-expiry" },
          text: { content: messageId },
        },
      });
    };

    adapter.start();
    try {
      emitFrame("msg-before-expiry");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(8 * 60_000 + 1);
      (sdkMockState.client as any).hasPendingReplyAck = vi.fn(() => true);
      emitFrame("msg-after-expiry");
      await Promise.resolve();

      expect(replyHandles).toHaveLength(2);
      expect(
        log.warn.mock.calls.some(([message]) =>
          String(message).includes("reason=req-id-pending-ack"),
        ),
      ).toBe(true);
      const successorHandle = replyHandles[1];
      sdkMockState.client?.replyStream.mockClear();
      sdkMockState.client?.sendMessage.mockClear();
      await successorHandle.deliver({ text: "successor pending-ack final" }, { kind: "final" });
      expect(sdkMockState.client?.replyStream).not.toHaveBeenCalled();
      expect(sdkMockState.client?.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      adapter.stop();
    }
  });

  it("keeps a new owner's identical final when the old owner loses claim during ACK wait", async () => {
    vi.useFakeTimers();
    const replyHandles: any[] = [];
    let pendingAck = false;
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn(async (_event, replyHandle) => {
        replyHandles.push(replyHandle);
      }),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);
    const emitFrame = (messageId: string) => {
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-owner-switch-during-wait" },
        body: {
          msgid: messageId,
          msgtype: "text",
          chattype: "single",
          from: { userid: "user-owner-switch" },
          text: { content: messageId },
        },
      });
    };

    adapter.start();
    try {
      (sdkMockState.client as any).hasPendingReplyAck = vi.fn(() => pendingAck);
      emitFrame("msg-old-owner");
      await Promise.resolve();
      const oldHandle = replyHandles[0];
      await vi.advanceTimersByTimeAsync(8 * 60_000 - 50);

      pendingAck = true;
      const oldFinalPromise = oldHandle.deliver({ text: "identical switched final" }, { kind: "final" });
      await Promise.resolve();
      pendingAck = false;
      await vi.advanceTimersByTimeAsync(51);
      emitFrame("msg-new-owner");
      await Promise.resolve();
      const newHandle = replyHandles[1];

      sdkMockState.client?.replyStream.mockClear();
      sdkMockState.client?.sendMessage.mockClear();
      await newHandle.deliver({ text: "identical switched final" }, { kind: "final" });
      expect(sdkMockState.client?.replyStream).toHaveBeenCalledTimes(1);
      expect(sdkMockState.client?.sendMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(49);
      await oldFinalPromise;
      expect(sdkMockState.client?.replyStream).toHaveBeenCalledTimes(1);
      expect(sdkMockState.client?.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      adapter.stop();
    }
  });

  it("leaves normal dispatch settlement to the runtime dispatcher", async () => {
    vi.useFakeTimers();
    const markDispatchSettled = vi.fn();
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn(async (_event, replyHandle) => {
        replyHandle.markDispatchSettled = markDispatchSettled;
      }),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);

    adapter.start();
    sdkMockState.client?.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-runtime-settlement" },
      body: {
        msgid: "msg-runtime-settlement",
        msgtype: "text",
        from: { userid: "user-1" },
        text: { content: "hello" },
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.handleEvent).toHaveBeenCalledOnce();
    expect(markDispatchSettled).not.toHaveBeenCalled();
    adapter.stop();
    vi.useRealTimers();
  });

  it("merges a media frame followed by a text frame before dispatching", async () => {
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };

    new BotWsSdkAdapter(runtime as any, {} as any).start();
    sdkMockState.client?.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-file" },
      body: {
        msgid: "msg-file",
        msgtype: "file",
        chattype: "single",
        from: { userid: "user-1" },
        file: { url: "https://example.com/report.pdf", aeskey: "file-key" },
      },
    });
    sdkMockState.client?.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-text" },
      body: {
        msgid: "msg-text",
        msgtype: "text",
        chattype: "single",
        from: { userid: "user-1" },
        text: { content: "请分析这个文件" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(runtime.handleEvent).toHaveBeenCalledOnce();
    const [event] = runtime.handleEvent.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      messageId: "msg-text",
      text: "请分析这个文件",
      dedupeAliases: ["msg-file"],
      attachments: [
        {
          name: "file",
          remoteUrl: "https://example.com/report.pdf",
          aesKey: "file-key",
        },
      ],
    });
  });

  it.each([
    ["slow ACK", { ackLatencyMs: 1_500 }, false],
    ["lost placeholder ACK", { ackLatencyMs: 60, dropAckOnSend: [1] }, true],
  ])(
    "keeps Agent body cumulative after a file frame merges with following text under %s",
    async (_label, gatewayOptions, expectsActivePush) => {
    vi.useFakeTimers();
    let dispatchSettled = false;
    const userId = expectsActivePush ? "user-lost-ack" : "user-slow-ack";
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn(async (event, replyHandle) => {
        const waitForNextAgentUpdate = () =>
          new Promise<void>((resolve) => setTimeout(resolve, 700));
        expect(event).toMatchObject({
          messageId: "msg-text-cumulative",
          text: "请分析这个文件",
          dedupeAliases: ["msg-file-cumulative"],
        });
        expect(event.attachments).toHaveLength(1);
        replyHandle.activate?.();
        await replyHandle.deliver(
          {
            text: "正在读取附件",
            channelData: { openclawProgressKind: "preamble" },
          },
          { kind: "block" },
        );
        await waitForNextAgentUpdate();
        await replyHandle.deliver({ text: "第一段正文。" }, { kind: "block" });
        await waitForNextAgentUpdate();
        await replyHandle.deliver(
          {
            text: "正在继续分析",
            channelData: { openclawProgressKind: "preamble" },
          },
          { kind: "block" },
        );
        await waitForNextAgentUpdate();
        await replyHandle.deliver({ text: "第二段正文。" }, { kind: "block" });
        await waitForNextAgentUpdate();
        await replyHandle.deliver({ text: "第三段结论。" }, { kind: "final" });
        replyHandle.markDispatchSettled?.();
        dispatchSettled = true;
      }),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };

    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);
    adapter.start();
    const client = sdkMockState.client;
    expect(client).not.toBeNull();
    // Keep the file placeholder ACK pending when the text and Agent updates
    // arrive. This exercises the SDK's non-blocking "skipped" path and the
    // reply handle's single latest-preview slot, not just the happy path.
    const sim = new WecomGatewaySim(gatewayOptions);
    client!.replyStream.mockImplementation(sim.replyStream.bind(sim) as any);
    (client as any).replyStreamNonBlocking = vi.fn(sim.replyStreamNonBlocking.bind(sim));
    (client as any).hasPendingReplyAck = vi.fn(sim.hasPendingReplyAck.bind(sim));
    client!.sendMessage.mockImplementation(sim.sendMessage.bind(sim) as any);

    client!.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-file-cumulative" },
      body: {
        msgid: "msg-file-cumulative",
        msgtype: "file",
        chattype: "single",
        from: { userid: userId },
        file: { url: "https://example.com/cumulative.pdf", aeskey: "file-key" },
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    client!.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-text-cumulative" },
      body: {
        msgid: "msg-text-cumulative",
        msgtype: "text",
        chattype: "single",
        from: { userid: userId },
        text: { content: "请分析这个文件" },
      },
    });

    for (let elapsed = 0; elapsed < 10_000 && !dispatchSettled; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(dispatchSettled).toBe(true);
    expect(runtime.handleEvent).toHaveBeenCalledOnce();
    if (expectsActivePush) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    const bubble = sim.streamBubble("req-file-cumulative");
    if (expectsActivePush) {
      const pushedFinal = sim.chat.findLast((entry) => entry.kind === "push");
      expect(pushedFinal?.kind).toBe("push");
      expect(pushedFinal?.content).toContain("第一段正文。");
      expect(pushedFinal?.content).toContain("第二段正文。");
      expect(pushedFinal?.content).toContain("第三段结论。");
      expect(pushedFinal?.content).not.toContain("正在继续分析");
    } else {
      expect(bubble?.kind).toBe("stream");
      if (bubble?.kind !== "stream") {
        throw new Error("expected the merged turn to use the file frame's stream bubble");
      }
      const firstBodyRevision = bubble.history.findIndex((text) => text.includes("第一段正文。"));
      expect(firstBodyRevision).toBeGreaterThanOrEqual(0);
      expect(
        bubble.history.some(
          (text) => text.includes("第一段正文。") && !text.includes("第三段结论。"),
        ),
      ).toBe(true);
      for (const revision of bubble.history.slice(firstBodyRevision)) {
        expect(revision).toContain("第一段正文。");
      }
      expect(bubble.content).toContain("第一段正文。");
      expect(bubble.content).toContain("第二段正文。");
      expect(bubble.content).toContain("第三段结论。");
      expect(bubble.content).not.toContain("正在继续分析");
    }
    expect(sim.streamBubble("req-text-cumulative")).toBeUndefined();

    adapter.stop();
    },
  );

  it("keeps Agent body cumulative for one documented mixed text-image frame", async () => {
    vi.useFakeTimers();
    let dispatchSettled = false;
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn(async (event, replyHandle) => {
        expect(event).toMatchObject({
          messageId: "msg-mixed-cumulative",
          inboundKind: "mixed",
          text: "请分析这张图\n[image] https://example.com/mixed.png",
          attachments: [
            {
              name: "image",
              remoteUrl: "https://example.com/mixed.png",
              aesKey: "mixed-key",
            },
          ],
        });
        replyHandle.activate?.();
        await replyHandle.deliver({ text: "第一段正文。" }, { kind: "block" });
        await new Promise<void>((resolve) => setTimeout(resolve, 700));
        await replyHandle.deliver({ text: "第二段正文。" }, { kind: "block" });
        await new Promise<void>((resolve) => setTimeout(resolve, 700));
        await replyHandle.deliver({ text: "第三段结论。" }, { kind: "final" });
        replyHandle.markDispatchSettled?.();
        dispatchSettled = true;
      }),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };

    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);
    adapter.start();
    const client = sdkMockState.client;
    expect(client).not.toBeNull();
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    client!.replyStream.mockImplementation(sim.replyStream.bind(sim) as any);
    (client as any).replyStreamNonBlocking = vi.fn(sim.replyStreamNonBlocking.bind(sim));
    (client as any).hasPendingReplyAck = vi.fn(sim.hasPendingReplyAck.bind(sim));
    client!.sendMessage.mockImplementation(sim.sendMessage.bind(sim) as any);

    client!.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-mixed-cumulative" },
      body: {
        msgid: "msg-mixed-cumulative",
        msgtype: "mixed",
        chattype: "single",
        from: { userid: "user-1" },
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "请分析这张图" } },
            {
              msgtype: "image",
              image: { url: "https://example.com/mixed.png", aeskey: "mixed-key" },
            },
          ],
        },
      },
    });

    for (let elapsed = 0; elapsed < 5_000 && !dispatchSettled; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(dispatchSettled).toBe(true);
    expect(runtime.handleEvent).toHaveBeenCalledOnce();

    const bubble = sim.streamBubble("req-mixed-cumulative");
    expect(bubble?.kind).toBe("stream");
    if (bubble?.kind !== "stream") {
      throw new Error("expected the mixed turn to use its only inbound stream bubble");
    }
    const firstBodyRevision = bubble.history.findIndex((text) => text.includes("第一段正文。"));
    expect(firstBodyRevision).toBeGreaterThanOrEqual(0);
    for (const revision of bubble.history.slice(firstBodyRevision)) {
      expect(revision).toContain("第一段正文。");
    }
    expect(bubble.content).toContain("第一段正文。");
    expect(bubble.content).toContain("第二段正文。");
    expect(bubble.content).toContain("第三段结论。");

    adapter.stop();
  });

  it("acknowledges a media frame while its merge window is still open", async () => {
    // The 1s merge window must not hold back the first bubble: a file upload
    // otherwise sits with no feedback until the window (and its download) end.
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };

    new BotWsSdkAdapter(runtime as any, {} as any).start();
    sdkMockState.client?.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-file-ack" },
      body: {
        msgid: "msg-file-ack",
        msgtype: "file",
        chattype: "single",
        from: { userid: "user-1" },
        file: { url: "https://example.com/ack.pdf", aeskey: "ack-key" },
      },
    });
    await waitForAsyncCallbacks();

    expect(runtime.handleEvent).not.toHaveBeenCalled();
    const placeholderCall = sdkMockState.client?.replyStream.mock.calls.at(0);
    expect(placeholderCall?.[0]?.headers?.req_id).toBe("req-file-ack");
    expect(String(placeholderCall?.[2] ?? "")).toContain("正在思考");
    expect(placeholderCall?.[3]).toBe(false);

    sdkMockState.client?.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-text-ack" },
      body: {
        msgid: "msg-text-ack",
        msgtype: "text",
        chattype: "single",
        from: { userid: "user-1" },
        text: { content: "这个文件讲了什么？" },
      },
    });
    await waitForAsyncCallbacks();

    expect(runtime.handleEvent).toHaveBeenCalledOnce();
    const [mergedEvent, replyHandle] = runtime.handleEvent.mock.calls[0] ?? [];
    expect(mergedEvent).toMatchObject({ messageId: "msg-text-ack" });
    // The merged turn answers on the bubble that is already open, so the file
    // frame never leaves an orphaned "thinking" placeholder behind.
    expect(replyHandle.context.reqId).toBe("req-file-ack");
  });

  it("does not dispatch a repeated media frame before merging its text", async () => {
    vi.useFakeTimers();
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);
    const mediaFrame = {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-file-redelivered" },
      body: {
        msgid: "msg-file-redelivered",
        msgtype: "file",
        chattype: "single",
        from: { userid: "user-1" },
        file: { url: "https://example.com/repeated.pdf", aeskey: "repeat-key" },
      },
    };

    try {
      adapter.start();
      sdkMockState.client?.emit("message", mediaFrame);
      sdkMockState.client?.emit("message", mediaFrame);
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-file-redelivered-text" },
        body: {
          msgid: "msg-file-redelivered-text",
          msgtype: "text",
          chattype: "single",
          from: { userid: "user-1" },
          text: { content: "分析重复投递的文件" },
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(runtime.handleEvent).toHaveBeenCalledOnce();
      expect(runtime.handleEvent.mock.calls[0]?.[0]).toMatchObject({
        messageId: "msg-file-redelivered-text",
        dedupeAliases: ["msg-file-redelivered"],
        attachments: [{ remoteUrl: "https://example.com/repeated.pdf" }],
      });
    } finally {
      adapter.stop();
      vi.useRealTimers();
    }
  });

  it("dispatches text immediately instead of waiting for a later media frame", async () => {
    vi.useFakeTimers();
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);

    try {
      adapter.start();
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-text-first" },
        body: {
          msgid: "msg-text-first",
          msgtype: "text",
          chattype: "single",
          from: { userid: "user-1" },
          text: { content: "请按附件里的数据生成汇总" },
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(runtime.handleEvent).toHaveBeenCalledOnce();
      expect(runtime.handleEvent.mock.calls[0]?.[0]).toMatchObject({
        messageId: "msg-text-first",
        text: "请按附件里的数据生成汇总",
      });
      expect(runtime.handleEvent.mock.calls[0]?.[0].attachments).toBeUndefined();

      await vi.advanceTimersByTimeAsync(250);
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-file-second" },
        body: {
          msgid: "msg-file-second",
          msgtype: "file",
          chattype: "single",
          from: { userid: "user-1" },
          file: { url: "https://example.com/data.xlsx", aeskey: "data-key" },
        },
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(runtime.handleEvent).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);

      expect(runtime.handleEvent).toHaveBeenCalledTimes(2);
      expect(runtime.handleEvent.mock.calls[1]?.[0]).toMatchObject({
        messageId: "msg-file-second",
        attachments: [
          {
            name: "file",
            remoteUrl: "https://example.com/data.xlsx",
            aesKey: "data-key",
          },
        ],
      });
    } finally {
      adapter.stop();
      vi.useRealTimers();
    }
  });

  it("keeps a media frame mergeable when its text arrives after the old 500ms window", async () => {
    vi.useFakeTimers();
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);

    try {
      adapter.start();
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-file-delayed" },
        body: {
          msgid: "msg-file-delayed",
          msgtype: "file",
          chattype: "single",
          from: { userid: "user-1" },
          file: { url: "https://example.com/delayed.pdf", aeskey: "delayed-key" },
        },
      });
      await vi.advanceTimersByTimeAsync(750);
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-text-delayed" },
        body: {
          msgid: "msg-text-delayed",
          msgtype: "text",
          chattype: "single",
          from: { userid: "user-1" },
          text: { content: "提取附件中的结论" },
        },
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(runtime.handleEvent).toHaveBeenCalledOnce();
      const [event] = runtime.handleEvent.mock.calls[0] ?? [];
      expect(event).toMatchObject({
        text: "提取附件中的结论",
        attachments: [
          {
            name: "file",
            remoteUrl: "https://example.com/delayed.pdf",
            aesKey: "delayed-key",
          },
        ],
      });
    } finally {
      adapter.stop();
      vi.useRealTimers();
    }
  });

  it.each([1_000, 1_001])(
    "dispatches later text separately at or after the media merge window (%dms)",
    async (textDelayMs) => {
    vi.useFakeTimers();
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);

    try {
      adapter.start();
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-expired-window-file" },
        body: {
          msgid: "msg-expired-window-file",
          msgtype: "file",
          chattype: "single",
          from: { userid: "user-1" },
          file: { url: "https://example.com/expired.pdf", aeskey: "expired-key" },
        },
      });
      await vi.advanceTimersByTimeAsync(textDelayMs);
      expect(runtime.handleEvent).toHaveBeenCalledOnce();

      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-expired-window-text" },
        body: {
          msgid: "msg-expired-window-text",
          msgtype: "text",
          chattype: "single",
          from: { userid: "user-1" },
          text: { content: "这是后续独立指令" },
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(runtime.handleEvent).toHaveBeenCalledTimes(2);
      expect(runtime.handleEvent.mock.calls[1]?.[0]).toMatchObject({
        messageId: "msg-expired-window-text",
        text: "这是后续独立指令",
      });
      expect(runtime.handleEvent.mock.calls[1]?.[0].attachments).toBeUndefined();
    } finally {
      adapter.stop();
      vi.useRealTimers();
    }
    },
  );

  it("flushes standalone media and keeps merge windows isolated per peer", async () => {
    vi.useFakeTimers();
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);
    adapter.start();

    sdkMockState.client?.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-media-only" },
      body: {
        msgid: "msg-media-only",
        msgtype: "file",
        chattype: "single",
        from: { userid: "user-1" },
        file: { url: "https://example.com/only.pdf", aeskey: "only-key" },
      },
    });
    sdkMockState.client?.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-other-peer" },
      body: {
        msgid: "msg-other-peer",
        msgtype: "text",
        chattype: "single",
        from: { userid: "user-2" },
        text: { content: "另一位用户的消息" },
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(runtime.handleEvent).toHaveBeenCalledTimes(2);
    expect(runtime.handleEvent.mock.calls.map(([event]) => event.text)).toEqual(
      expect.arrayContaining(["[file] https://example.com/only.pdf", "另一位用户的消息"]),
    );
    adapter.stop();
    vi.useRealTimers();
  });

  it("does not merge media and text from different senders in the same group", async () => {
    vi.useFakeTimers();
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);

    try {
      adapter.start();
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-group-file" },
        body: {
          msgid: "msg-group-file",
          msgtype: "file",
          chattype: "group",
          chatid: "group-1",
          from: { userid: "user-1" },
          file: { url: "https://example.com/group.pdf", aeskey: "group-key" },
        },
      });
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-group-text" },
        body: {
          msgid: "msg-group-text",
          msgtype: "text",
          chattype: "group",
          chatid: "group-1",
          from: { userid: "user-2" },
          text: { content: "分析这份文件" },
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(runtime.handleEvent).toHaveBeenCalledTimes(2);
      expect(runtime.handleEvent.mock.calls.map(([event]) => event.conversation.senderId)).toEqual(
        expect.arrayContaining(["user-1", "user-2"]),
      );
    } finally {
      adapter.stop();
      vi.useRealTimers();
    }
  });

  it("starts same-peer media dispatches in arrival order without waiting for completion", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstDispatch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi
        .fn()
        .mockImplementationOnce(() => firstDispatch)
        .mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);

    try {
      adapter.start();
      for (const [suffix, url] of [
        ["first", "https://example.com/first.pdf"],
        ["second", "https://example.com/second.pdf"],
      ]) {
        sdkMockState.client?.emit("message", {
          cmd: "aibot_msg_callback",
          headers: { req_id: `req-${suffix}` },
          body: {
            msgid: `msg-${suffix}`,
            msgtype: "file",
            chattype: "single",
            from: { userid: "user-1" },
            file: { url, aeskey: `${suffix}-key` },
          },
        });
      }
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(runtime.handleEvent).toHaveBeenCalledTimes(2);
      expect(runtime.handleEvent.mock.calls[0]?.[0].messageId).toBe("msg-first");
      expect(runtime.handleEvent.mock.calls[1]?.[0].messageId).toBe("msg-second");

      releaseFirst();
      await Promise.resolve();
    } finally {
      adapter.stop();
      vi.useRealTimers();
    }
  });

  it("keeps the second media mergeable with following text while the first dispatch is running", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstDispatch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi
        .fn()
        .mockImplementationOnce(() => firstDispatch)
        .mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);

    try {
      adapter.start();
      for (const [suffix, url] of [
        ["first", "https://example.com/first.pdf"],
        ["second", "https://example.com/second.pdf"],
      ]) {
        sdkMockState.client?.emit("message", {
          cmd: "aibot_msg_callback",
          headers: { req_id: `req-${suffix}-with-text` },
          body: {
            msgid: `msg-${suffix}-with-text`,
            msgtype: "file",
            chattype: "single",
            from: { userid: "user-1" },
            file: { url, aeskey: `${suffix}-key` },
          },
        });
      }
      sdkMockState.client?.emit("message", {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-second-text" },
        body: {
          msgid: "msg-second-text",
          msgtype: "text",
          chattype: "single",
          from: { userid: "user-1" },
          text: { content: "请分析第二个文件" },
        },
      });
      await vi.advanceTimersByTimeAsync(500);

      expect(runtime.handleEvent).toHaveBeenCalledTimes(2);
      expect(runtime.handleEvent.mock.calls[1]?.[0]).toMatchObject({
        messageId: "msg-second-text",
        text: "请分析第二个文件",
        attachments: [
          {
            remoteUrl: "https://example.com/second.pdf",
            aesKey: "second-key",
          },
        ],
      });
      releaseFirst();
      await Promise.resolve();
    } finally {
      releaseFirst();
      adapter.stop();
      vi.useRealTimers();
    }
  });

  it("does not let a stopped adapter retry an old final through its replacement connection", async () => {
    vi.useFakeTimers();
    const expiredError = {
      errcode: 846608,
      errmsg: "stream message update expired",
    };
    const pushError = Object.assign(new Error("push rejected"), { errcode: 95001 });
    const oldRuntime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn(async (_event, replyHandle) => {
        replyHandle.activate?.();
        await replyHandle.deliver({ text: "旧连接的最终答案" }, { kind: "final" });
        replyHandle.markDispatchSettled?.();
      }),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const oldAdapter = new BotWsSdkAdapter(oldRuntime as any, {} as any);
    oldAdapter.start();
    const oldClient = sdkMockState.client!;
    oldClient.replyStream
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(expiredError);
    oldClient.sendMessage.mockRejectedValue(pushError);

    sdkMockState.client?.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-old-retry" },
      body: {
        msgid: "msg-old-retry",
        msgtype: "text",
        chattype: "single",
        from: { userid: "user-1" },
        text: { content: "执行旧任务" },
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(oldClient.sendMessage).toHaveBeenCalled();

    oldAdapter.stop();
    const replacementRuntime = {
      ...oldRuntime,
      handleEvent: vi.fn(),
    };
    const replacementAdapter = new BotWsSdkAdapter(replacementRuntime as any, {} as any);
    replacementAdapter.start();
    const replacementClient = sdkMockState.client!;

    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.resolve();

    expect(replacementClient.sendMessage).not.toHaveBeenCalled();
    replacementAdapter.stop();
    vi.useRealTimers();
  });

  it("notifies the active reply when its adapter stops", async () => {
    vi.useFakeTimers();
    const transportRetired = vi.fn();
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn(async (_event, replyHandle) => {
        replyHandle.onTransportRetired?.(transportRetired);
        replyHandle.activate?.();
        await dispatchGate;
      }),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const adapter = new BotWsSdkAdapter(runtime as any, {} as any);

    adapter.start();
    sdkMockState.client?.emit("message", {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-stop-active" },
      body: {
        msgid: "msg-stop-active",
        msgtype: "text",
        chattype: "single",
        from: { userid: "user-1" },
        text: { content: "long task" },
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(runtime.handleEvent).toHaveBeenCalledOnce();

    adapter.stop();

    expect(transportRetired).toHaveBeenCalledOnce();
    releaseDispatch();
    await Promise.resolve();
    vi.useRealTimers();
  });

  it("short-circuits enter_chat welcome events to a static ws welcome reply", async () => {
    process.on("unhandledRejection", onUnhandledRejection);

    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: {
            botId: "bot-1",
            secret: "secret-1",
          },
          config: {
            welcomeText: "欢迎来到 WeCom",
          },
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    new BotWsSdkAdapter(runtime as any, log as any).start();

    sdkMockState.client?.emit("event", {
      cmd: "aibot_event_callback",
      headers: { req_id: "req-welcome" },
      body: {
        msgid: "msg-welcome",
        msgtype: "event",
        chattype: "single",
        from: { userid: "user-1" },
        event: { eventtype: "enter_chat" },
      },
    });

    await waitForAsyncCallbacks();

    expect(runtime.handleEvent).not.toHaveBeenCalled();
    expect(sdkMockState.client?.replyWelcome).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { req_id: "req-welcome" },
      }),
      {
        msgtype: "text",
        text: { content: "欢迎来到 WeCom" },
      },
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("static welcome delivered account=acc-1 messageId=msg-welcome"),
    );
    expect(unhandledRejections).toHaveLength(0);
  });

  it("does not start an agent run when WeCom hands this bot to a new connection", async () => {
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    new BotWsSdkAdapter(runtime as any, log as any).start();

    // WeCom pushes this to the OLD connection right before terminating it.
    // It carries no sender and no chat, so a dispatch would land on "unknown".
    sdkMockState.client?.emit("event", {
      cmd: "aibot_event_callback",
      headers: { req_id: "req-kick" },
      body: {
        msgid: "msg-kick",
        create_time: 1700000000,
        aibotid: "AIBOTID",
        msgtype: "event",
        event: { eventtype: "disconnected_event" },
      },
    });

    await waitForAsyncCallbacks();

    expect(runtime.handleEvent).not.toHaveBeenCalled();
    expect(sdkMockState.client?.sendMessage).not.toHaveBeenCalled();
    expect(sdkMockState.client?.replyStream).not.toHaveBeenCalled();
    expect(unhandledRejections).toHaveLength(0);
  });

  it("records ws-kicked and never reconnects when a new connection takes over", async () => {
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    new BotWsSdkAdapter(runtime as any, log as any).start();
    const connectsAfterStart = sdkMockState.client?.connectCalls ?? 0;

    sdkMockState.client?.emit("event", {
      cmd: "aibot_event_callback",
      headers: { req_id: "req-kick" },
      body: {
        msgid: "msg-kick",
        msgtype: "event",
        event: { eventtype: "disconnected_event" },
      },
    });
    // The SDK follows the event with its own disconnect notice, whose reason
    // text matches none of the legacy kicked keywords.
    sdkMockState.client?.emit(
      "disconnected",
      "New connection established, server disconnected this connection",
    );

    await waitForAsyncCallbacks();

    expect(runtime.recordOperationalIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: "bot-ws",
        category: "ws-kicked",
        error: "disconnected_event",
      }),
    );
    // Reconnecting would take the bot back from whoever now owns it, and that
    // owner would kick us again: the two instances would trade the connection
    // forever.
    expect(sdkMockState.client?.connectCalls).toBe(connectsAfterStart);
    expect(runtime.updateTransportSession).toHaveBeenCalledWith(
      expect.objectContaining({ connected: false, running: false }),
    );
    expect(unhandledRejections).toHaveLength(0);
  });

  it("still dispatches ordinary events after the disconnect filter", async () => {
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    new BotWsSdkAdapter(runtime as any, log as any).start();

    sdkMockState.client?.emit("event", {
      cmd: "aibot_event_callback",
      headers: { req_id: "req-card" },
      body: {
        msgid: "msg-card",
        msgtype: "event",
        chattype: "single",
        from: { userid: "user-1" },
        event: {
          eventtype: "template_card_event",
          template_card_event: { card_type: "button_interaction", event_key: "confirm" },
        },
      },
    });

    await waitForAsyncCallbacks();

    expect(runtime.handleEvent).toHaveBeenCalledTimes(1);
    expect(runtime.recordOperationalIssue).not.toHaveBeenCalled();
    expect(unhandledRejections).toHaveLength(0);
  });

  it("tags an active push with the conversation kind, and omits it when unknown", async () => {
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    new BotWsSdkAdapter(runtime as any, log as any).start();
    const handle = getBotWsPushHandle("acc-1");

    await handle?.sendMarkdown("user-1", "direct push", "direct");
    await handle?.sendMarkdown("chat-1", "group push", "group");
    // Callers that cannot tell keep the previous wire shape.
    await handle?.sendMarkdown("user-1", "unspecified push");

    const calls = sdkMockState.client?.sendMessage.mock.calls ?? [];
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[1]).toMatchObject({ chat_type: 1, markdown: { content: "direct push" } });
    expect(calls[1]?.[1]).toMatchObject({ chat_type: 2, markdown: { content: "group push" } });
    expect(calls[2]?.[1]).not.toHaveProperty("chat_type");
  });

  it("回复企微的版本握手事件，而不是拿它跑一轮 agent", async () => {
    // enter_check_update 只在官方源码里出现，文档没写：企微推它，期望插件
    // 回复自身版本。我们此前会把它当成一条用户消息派发出去。
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: { wsConfigured: true, ws: { botId: "bot-1", secret: "secret-1" }, config: {} },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    new BotWsSdkAdapter(runtime as any, log as any).start();

    sdkMockState.client?.emit("event", {
      cmd: "aibot_event_callback",
      headers: { req_id: "req-check" },
      body: { msgid: "m1", msgtype: "event", event: { eventtype: "enter_check_update" } },
    });
    await waitForAsyncCallbacks();

    expect(runtime.handleEvent).not.toHaveBeenCalled();
    const replyCall = sdkMockState.client?.reply.mock.calls[0];
    expect(replyCall?.[1]).toEqual({ version: expect.stringMatching(/^\d/) });
    expect(replyCall?.[2]).toBe("ww_ai_robot_enter_event");
  });

  it("不认识的事件类型一律不进 agent 通道（白名单，与官方一致）", async () => {
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: { wsConfigured: true, ws: { botId: "bot-1", secret: "secret-1" }, config: {} },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    new BotWsSdkAdapter(runtime as any, log as any).start();

    sdkMockState.client?.emit("event", {
      cmd: "aibot_event_callback",
      headers: { req_id: "req-x" },
      body: { msgid: "m2", msgtype: "event", event: { eventtype: "some_future_event" } },
    });
    await waitForAsyncCallbacks();

    expect(runtime.handleEvent).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("event ignored account=acc-1 eventtype=some_future_event"),
    );
  });

  it("授权变更事件照常派发，并作废该账号的 MCP 配置缓存", async () => {
    // 成员刚在后台改过「可使用权限」，手上那份 MCP 配置与会话可能已不对应。
    const runtime = {
      account: {
        accountId: "acc-1",
        bot: { wsConfigured: true, ws: { botId: "bot-1", secret: "secret-1" }, config: {} },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    new BotWsSdkAdapter(runtime as any, log as any).start();

    sdkMockState.client?.emit("event", {
      cmd: "aibot_event_callback",
      headers: { req_id: "req-auth" },
      body: {
        msgid: "m3",
        msgtype: "event",
        chattype: "single",
        from: { userid: "user-1" },
        event: { eventtype: "auth_change_event", auth_change_event: { auth_list: [1, 2] } },
      },
    });
    await waitForAsyncCallbacks();

    expect(runtime.handleEvent).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("auth changed account=acc-1"),
    );
  });

  it("keeps a replacement push handle when the stale adapter stops", () => {
    const createRuntime = () => ({
      account: {
        accountId: "acc-1",
        bot: {
          wsConfigured: true,
          ws: { botId: "bot-1", secret: "secret-1" },
          config: {},
        },
      },
      handleEvent: vi.fn().mockResolvedValue(undefined),
      updateTransportSession: vi.fn(),
      touchTransportSession: vi.fn(),
      recordOperationalIssue: vi.fn(),
    });
    const staleAdapter = new BotWsSdkAdapter(createRuntime() as any, {} as any);
    const replacementAdapter = new BotWsSdkAdapter(createRuntime() as any, {} as any);
    staleAdapter.start();
    const staleHandle = getBotWsPushHandle("acc-1");
    replacementAdapter.start();
    const replacementHandle = getBotWsPushHandle("acc-1");

    expect(replacementHandle).toBeDefined();
    expect(replacementHandle).not.toBe(staleHandle);
    expect(staleHandle?.ownerId).toBeDefined();
    expect(replacementHandle?.ownerId).toBeDefined();
    expect(replacementHandle?.ownerId).not.toBe(staleHandle?.ownerId);
    staleAdapter.stop();
    expect(getBotWsPushHandle("acc-1")).toBe(replacementHandle);

    replacementAdapter.stop();
    expect(getBotWsPushHandle("acc-1")).toBeUndefined();
  });
});
