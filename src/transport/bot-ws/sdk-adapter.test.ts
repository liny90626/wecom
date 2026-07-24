import { afterEach, describe, expect, it, vi } from "vitest";

const sdkMockState = vi.hoisted(() => {
  class MockWSClient {
    readonly handlers = new Map<string, Array<(payload: any) => void>>();
    readonly isConnected = true;
    readonly replyStream = vi.fn().mockResolvedValue(undefined);
    readonly replyWelcome = vi.fn().mockResolvedValue(undefined);
    readonly sendMessage = vi.fn().mockResolvedValue(undefined);

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

    connect(): void {}

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
    await vi.advanceTimersByTimeAsync(499);
    expect(runtime.handleEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(runtime.handleEvent).toHaveBeenCalledOnce();
    expect(sdkMockState.client?.replyStream).toHaveBeenCalledOnce();
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
      attachments: [
        {
          name: "file",
          remoteUrl: "https://example.com/report.pdf",
          aesKey: "file-key",
        },
      ],
    });
  });

  it("merges a text frame followed by a media frame before dispatching", async () => {
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
      await vi.advanceTimersByTimeAsync(2_000);

      expect(runtime.handleEvent).toHaveBeenCalledOnce();
      const [event] = runtime.handleEvent.mock.calls[0] ?? [];
      expect(event).toMatchObject({
        text: "请按附件里的数据生成汇总",
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

  it("preserves same-peer media ordering while the first dispatch is still running", async () => {
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

      expect(runtime.handleEvent).toHaveBeenCalledOnce();
      expect(runtime.handleEvent.mock.calls[0]?.[0].messageId).toBe("msg-first");

      releaseFirst();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(runtime.handleEvent).toHaveBeenCalledTimes(2);
      expect(runtime.handleEvent.mock.calls[1]?.[0].messageId).toBe("msg-second");
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

      expect(runtime.handleEvent).toHaveBeenCalledOnce();

      releaseFirst();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

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
    staleAdapter.stop();
    expect(getBotWsPushHandle("acc-1")).toBe(replacementHandle);

    replacementAdapter.stop();
    expect(getBotWsPushHandle("acc-1")).toBeUndefined();
  });
});
