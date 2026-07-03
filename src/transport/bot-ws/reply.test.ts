import os from "node:os";
import path from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import { uploadAndSendBotWsMedia } from "./media.js";
import { __resetBotWsReplyTestState, createBotWsReplyHandle } from "./reply.js";

vi.mock("./media.js", () => ({
  uploadAndSendBotWsMedia: vi.fn(),
}));

type ReplyHandleParams = Parameters<typeof createBotWsReplyHandle>[0];
const FINAL_COMPLETION_MARKER = "（回复完毕）";

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
    expect(firstPreview).toContain("正在思考中...0s");

    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    const secondPreview = String(mockClient.replyStream.mock.calls[1]?.[2] ?? "");
    expect(secondPreview).toContain("预览内容。");
    expect(secondPreview).toContain("正在思考中...15s");
    expect(secondPreview).not.toContain("END-FROZEN");
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
      "正在查询数据源\n\n正在整理结果...5m00s",
      false,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(3);
    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-preview-time-freeze" } }),
      expect.any(String),
      "正在查询数据源\n\n正在整理结果...5m15s",
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

  it("deduplicates repeated large blocks in long final text", async () => {
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
    expect(delivered.match(/重复观察00/g)?.length).toBe(1);
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
    const secondReport = [
      "今日活跃企微会话与定时任务汇总（2026-06-26 12:44）",
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
      "",
      "二、定时任务概览",
      "",
      "| 任务名 | 模型 | LC | 上次执行 | 成功率 | 修复状态 |",
      "|---|---|---|---|---:|---|",
      "| 安全审查-全天（全团队） | it-server/gpt-5.5 | 默认 | 成功 | - |  |",
      "",
      "三、异常与观察项",
      "",
      "· 当前连续失败：1 个",
    ].join("\n");
    const filler = Array.from({ length: 70 }, (_, index) =>
      `补充明细${String(index).padStart(2, "0")}：这是一段用于模拟长报告正文的内容，保证 final 触发长文本去重。`,
    ).join("\n");
    const finalText = `${firstReport}\n\n${filler}\n\n${secondReport}`;

    const deliverPromise = handle.deliver({ text: finalText, isReasoning: false }, { kind: "final" });
    await drainChunkTimers();
    await deliverPromise;

    const delivered = [
      String(mockClient.replyStream.mock.calls[0]?.[2] ?? ""),
      ...mockClient.sendMessage.mock.calls.map((call) => String((call[1] as any).markdown.content)),
    ].join("\n");
    expect(delivered).toContain("三、异常与观察项");
    expect(delivered).toContain("补充明细69");
    expect(delivered.match(/今日活跃企微会话与定时任务汇总/g)?.length).toBe(1);
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
    // The dead preview channel triggers a one-time expired notice first.
    expect(pushedContents[0]).toContain("进度预览暂时无法继续刷新");
    const finalPush = pushedContents.find((content) => content.includes("压测结果完成"));
    expect(finalPush).toBeDefined();
    expect(finalPush).toContain("继续输出：");
    expect(finalPush).toContain(FINAL_COMPLETION_MARKER);
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
    nonBlockingClient.replyStreamNonBlocking = vi
      .fn()
      .mockResolvedValueOnce({} as any)
      .mockResolvedValueOnce("skipped");
    nonBlockingClient.hasPendingReplyAck = vi.fn().mockReturnValue(true);

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

    expect(nonBlockingClient.replyStreamNonBlocking).toHaveBeenCalledTimes(2);
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
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(400_000);
    await flushPromises();
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(4);
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
    let pendingAck = true;
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

  it("retries the superseded merge push after a transient failure", async () => {
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

    // No visible text yet, so the superseded final merge-delivers by push;
    // the transient failure surfaces to the core and schedules a retry.
    await expect(
      handle.deliver({ text: "旧任务合并结果", isReasoning: false }, { kind: "final" }),
    ).rejects.toThrow("push down");
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();

    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    const retried = String((mockClient.sendMessage.mock.calls[1]?.[1] as any).markdown.content);
    expect(retried).toContain("旧任务合并结果");
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
    // The already-delivered first chunk must not be re-sent by the retry.
    expect(pushedContents.filter((content) => content.includes("AAA段落")).length).toBe(1);
    expect(pushedContents.filter((content) => content.includes("BBB段落")).length).toBe(2);
    expect(pushedContents.filter((content) => content.includes("CCC段落")).length).toBe(1);
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
    await vi.advanceTimersByTimeAsync(3_600_000);
    await flushPromises();
    const callsAtCap = mockClient.replyStream.mock.calls.length;
    expect(callsAtCap).toBeGreaterThan(2);

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
    nonBlockingClient.replyStreamNonBlocking = vi.fn().mockResolvedValue({} as any);
    nonBlockingClient.hasPendingReplyAck = vi.fn().mockReturnValue(true);

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
    expect(String(lastCall?.[2])).toMatch(/正在(思考中|处理数据|整理结果)/);
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
