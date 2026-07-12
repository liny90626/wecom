import { describe, expect, test, vi } from "vitest";

import type { WecomBotInboundMessage as WecomInboundMessage } from "../types/index.js";
import type { WecomWebhookTarget } from "./types.js";
import { StreamStore } from "./state.js";

describe("wecom StreamStore queue", () => {
  test("settles merged acknowledgement streams on every batch terminal path", () => {
    const store = new StreamStore();
    const batchStreamId = store.createStream({});
    const ackStreamId = store.createStream({ msgid: "ACK-1" });
    store.updateStream(ackStreamId, (state) => {
      state.started = true;
      state.content = "已收到，已合并排队处理中...";
    });
    store.addAckStreamForBatch({ batchStreamId, ackStreamId });

    expect(store.onStreamFinished(batchStreamId)).toEqual([ackStreamId]);
    expect(store.getStream(ackStreamId)).toEqual(
      expect.objectContaining({
        content: "✅ 已合并处理完成，请查看上一条回复。",
        finished: true,
      }),
    );
    expect(store.onStreamFinished(batchStreamId)).toEqual([]);
  });

  test("does not merge into active batch; flushes queued batch after active finishes", async () => {
    vi.useFakeTimers();
    try {
      const store = new StreamStore();
      const flushed: string[] = [];
      store.setFlushHandler((pending) => flushed.push(pending.streamId));

      const target = {
        account: {} as any,
        config: {} as any,
        runtime: {},
        core: {} as any,
        path: "/wecom",
      } satisfies WecomWebhookTarget;

      const conversationKey = "wecom:default:U:C";

      const msg1 = { msgid: "M1" } satisfies WecomInboundMessage;
      const msg2 = { msgid: "M2" } satisfies WecomInboundMessage;

      const r1 = store.addPendingMessage({
        conversationKey,
        target,
        msg: msg1,
        msgContent: "1",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });
      const r2 = store.addPendingMessage({
        conversationKey,
        target,
        msg: msg2,
        msgContent: "2",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });

      expect(r1.status).toBe("active_new");
      // 初始批次不接收合并：第二条进入 queued
      expect(r2.status).toBe("queued_new");
      expect(r2.streamId).not.toBe(r1.streamId);

      // Follow-ups within queued should merge into queued (status queued_merged).
      const r3 = store.addPendingMessage({
        conversationKey,
        target,
        msg: { msgid: "M3" } as any,
        msgContent: "3",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });
      expect(r3.status).toBe("queued_merged");
      expect(r3.streamId).toBe(r2.streamId);

      // Active batch flushes at debounce time.
      await vi.advanceTimersByTimeAsync(11);
      expect(flushed).toEqual([r1.streamId]);

      // Queued batch timer also fires, but cannot flush until active finishes.
      await vi.advanceTimersByTimeAsync(11);
      expect(flushed).toEqual([r1.streamId]);

      // Once the active stream finishes, queued batch is promoted and flushes immediately.
      store.onStreamFinished(r1.streamId);
      expect(flushed).toEqual([r1.streamId, r2.streamId]);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    {
      name: "text then file",
      messages: [
        { msgid: "M1", msgtype: "text", text: { content: "请分析附件" } },
        { msgid: "M2", msgtype: "file", file: { url: "https://example.com/a.pdf" } },
      ],
      contents: ["请分析附件", "[file]"],
    },
    {
      name: "file then text",
      messages: [
        { msgid: "M1", msgtype: "file", file: { url: "https://example.com/a.pdf" } },
        { msgid: "M2", msgtype: "text", text: { content: "请结合文件回答" } },
      ],
      contents: ["[file]", "请结合文件回答"],
    },
    {
      name: "two images then text",
      messages: [
        { msgid: "M1", msgtype: "image", image: { url: "https://example.com/one.png" } },
        { msgid: "M2", msgtype: "image", image: { url: "https://example.com/two.png" } },
        { msgid: "M3", msgtype: "text", text: { content: "比较两张图" } },
      ],
      contents: ["[image]", "[image]", "比较两张图"],
    },
  ])("merges a short $name burst into one ordered initial batch", async ({ messages, contents }) => {
    vi.useFakeTimers();
    try {
      const store = new StreamStore();
      let flushedPending: any;
      store.setFlushHandler((pending) => {
        flushedPending = pending;
      });
      const target = {
        account: {} as any,
        config: {} as any,
        runtime: {},
        core: {} as any,
        path: "/wecom",
      } satisfies WecomWebhookTarget;
      const conversationKey = `wecom:default:U:${messages.length}`;

      const results = messages.map((msg, index) =>
        store.addPendingMessage({
          conversationKey,
          target,
          msg: msg as WecomInboundMessage,
          msgContent: contents[index]!,
          nonce: "n",
          timestamp: "t",
          debounceMs: 10,
        }),
      );

      expect(results[0]?.status).toBe("active_new");
      expect(results.slice(1).every((result) => result.status === "active_merged")).toBe(true);
      expect(new Set(results.map((result) => result.streamId)).size).toBe(1);

      await vi.advanceTimersByTimeAsync(11);

      expect(flushedPending.contents).toEqual(contents);
      expect(flushedPending.messages.map((msg: WecomInboundMessage) => msg.msgid)).toEqual(
        messages.map((msg) => msg.msgid),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps later media in the queued batch once a queued message exists", async () => {
    vi.useFakeTimers();
    try {
      const store = new StreamStore();
      const flushed: any[] = [];
      store.setFlushHandler((pending) => flushed.push(pending));
      const target = {
        account: {} as any,
        config: {} as any,
        runtime: {},
        core: {} as any,
        path: "/wecom",
      } satisfies WecomWebhookTarget;
      const conversationKey = "wecom:default:U:no-reorder";

      const first = store.addPendingMessage({
        conversationKey,
        target,
        msg: { msgid: "M1", msgtype: "text", text: { content: "先处理这个" } } as any,
        msgContent: "先处理这个",
        nonce: "n",
        timestamp: "t",
        debounceMs: 100,
      });
      const second = store.addPendingMessage({
        conversationKey,
        target,
        msg: { msgid: "M2", msgtype: "text", text: { content: "第二个问题" } } as any,
        msgContent: "第二个问题",
        nonce: "n",
        timestamp: "t",
        debounceMs: 100,
      });
      const third = store.addPendingMessage({
        conversationKey,
        target,
        msg: { msgid: "M3", msgtype: "file", file: { url: "https://example.com/a.pdf" } } as any,
        msgContent: "[file]",
        nonce: "n",
        timestamp: "t",
        debounceMs: 100,
      });

      expect(first.status).toBe("active_new");
      expect(second.status).toBe("queued_new");
      expect(third.status).toBe("queued_merged");
      expect(third.streamId).toBe(second.streamId);

      await vi.advanceTimersByTimeAsync(101);
      expect(flushed.map((pending) => pending.contents)).toEqual([["先处理这个"]]);

      store.onStreamFinished(first.streamId);
      expect(flushed.map((pending) => pending.contents)).toEqual([
        ["先处理这个"],
        ["第二个问题", "[file]"],
      ]);
      expect(flushed[1].messages.map((msg: WecomInboundMessage) => msg.msgid)).toEqual(["M2", "M3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not treat a literal media marker in a text message as an attachment", () => {
    const store = new StreamStore();
    const target = {
      account: {} as any,
      config: {} as any,
      runtime: {},
      core: {} as any,
      path: "/wecom",
    } satisfies WecomWebhookTarget;
    const conversationKey = "wecom:default:U:literal-marker";

    const first = store.addPendingMessage({
      conversationKey,
      target,
      msg: { msgid: "M1", msgtype: "text", text: { content: "第一条" } } as any,
      msgContent: "第一条",
      nonce: "n",
      timestamp: "t",
    });
    const second = store.addPendingMessage({
      conversationKey,
      target,
      msg: { msgid: "M2", msgtype: "text", text: { content: "[file] 只是文字" } } as any,
      msgContent: "[file] 只是文字",
      nonce: "n",
      timestamp: "t",
    });

    expect(first.status).toBe("active_new");
    expect(second.status).toBe("queued_new");
  });

  test("merges into active batch when it has not started yet (even after promotion)", async () => {
    vi.useFakeTimers();
    try {
      const store = new StreamStore();
      const flushed: string[] = [];
      store.setFlushHandler((pending) => flushed.push(pending.streamId));

      const target = {
        account: {} as any,
        config: {} as any,
        runtime: {},
        core: {} as any,
        path: "/wecom",
      } satisfies WecomWebhookTarget;

      const conversationKey = "wecom:default:U:C2";

      // 1 becomes active and flushes; mark as started to simulate "processing started".
      const r1 = store.addPendingMessage({
        conversationKey,
        target,
        msg: { msgid: "M1" } as any,
        msgContent: "1",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });
      store.markStarted(r1.streamId);
      await vi.advanceTimersByTimeAsync(11);
      expect(flushed).toEqual([r1.streamId]);

      // 2 enters queued with a longer debounce; it should NOT become readyToFlush yet.
      const r2 = store.addPendingMessage({
        conversationKey,
        target,
        msg: { msgid: "M2" } as any,
        msgContent: "2",
        nonce: "n",
        timestamp: "t",
        debounceMs: 100,
      });
      expect(flushed).toEqual([r1.streamId]);

      // Finish 1, promote 2 to active (but do NOT flush immediately since it's not readyToFlush).
      store.onStreamFinished(r1.streamId);
      expect(flushed).toEqual([r1.streamId]);

      // Now 2 is active, but (in real monitor) it may still be in debounce before markStarted.
      // We simulate that by NOT calling markStarted. Follow-up should merge into active (same streamId).
      const r3 = store.addPendingMessage({
        conversationKey,
        target,
        msg: { msgid: "M3" } as any,
        msgContent: "3",
        nonce: "n",
        timestamp: "t",
        debounceMs: 10,
      });
      expect(r3.streamId).toBe(r2.streamId);
      expect(r3.status).toBe("active_merged");
    } finally {
      vi.useRealTimers();
    }
  });

  test("clears conversation state when idle so next message becomes active", async () => {
    const store = new StreamStore();
    store.setFlushHandler(() => { });

    const target = {
      account: {} as any,
      config: {} as any,
      runtime: {},
      core: {} as any,
      path: "/wecom",
    } satisfies WecomWebhookTarget;

    const conversationKey = "wecom:default:U:idle";

    const r1 = store.addPendingMessage({
      conversationKey,
      target,
      msg: { msgid: "M1" } as any,
      msgContent: "1",
      nonce: "n",
      timestamp: "t",
      debounceMs: 10,
    });
    store.markStarted(r1.streamId);
    store.markFinished(r1.streamId);
    store.onStreamFinished(r1.streamId);

    const r2 = store.addPendingMessage({
      conversationKey,
      target,
      msg: { msgid: "M2" } as any,
      msgContent: "2",
      nonce: "n",
      timestamp: "t",
      debounceMs: 10,
    });
    expect(r2.status).toBe("active_new");
    expect(r2.streamId).not.toBe(r1.streamId);
  });
});
