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

describe("createBotWsReplyHandle", () => {
  let mockClient: import("vitest").Mocked<WSClient>;
  const uploadAndSendBotWsMediaMock = vi.mocked(uploadAndSendBotWsMedia);

  const flushPromises = async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
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

  it("renders reasoning in a think block and keeps final body separate", async () => {
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
      "<think>先分析需求</think>",
      false,
    );

    const finalText = String(mockClient.replyStream.mock.calls[1]?.[2] ?? "");
    expect(finalText).toContain("<think>先分析需求\n再核对约束</think>");
    expect(finalText).toContain("最终正文");
    expect(finalText.replace(/<think>[\s\S]*?<\/think>/g, "")).not.toContain("先分析需求");
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
  });

  it("strips markup from thinking content before wrapping it in a think block", async () => {
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

    const finalText = String(mockClient.replyStream.mock.calls.at(-1)?.[2] ?? "");
    expect(finalText).toContain("<think>先内部alert(1)结束</think>");
    expect(finalText).not.toContain("<script>");
    expect(finalText.match(/<think>/g)).toHaveLength(1);
    expect(finalText.match(/<\/think>/g)).toHaveLength(1);
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
    expect(previewText).toContain("正文预览");
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
    await flushPromises();
    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(800);
    await deliverPromise;

    const firstChunk = String(mockClient.replyStream.mock.calls[1]?.[2] ?? "");
    const pushedText = mockClient.sendMessage.mock.calls
      .map((call) => String((call[1] as any).markdown.content))
      .join("\n");
    expect(firstChunk).toContain("<think>这是思考过程</think>");
    expect(firstChunk).toContain("第1/");
    expect(pushedText).toContain("END-THINK-B2");
    expect(pushedText).not.toContain("<think>");
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

    await handle.deliver({ text: "最终正文", isReasoning: false }, { kind: "final" });
    expect(mockClient.replyStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { req_id: "req-preview-final-stop" } }),
      expect.any(String),
      `${longBlock}\n最终正文`,
      true,
    );

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
    expect(pushed).not.toContain("<think>");
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
    await flushPromises();
    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(800);
    await deliverPromise;

    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-long-final" } }),
      expect.any(String),
      expect.stringContaining("第1/"),
      true,
    );
    expect(mockClient.sendMessage).toHaveBeenCalled();
    const pushedText = mockClient.sendMessage.mock.calls
      .map((call) => (call[1] as any).markdown.content)
      .join("\n");
    expect(pushedText).toContain("END-B2");
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

    await handle.deliver({ text: finalText, isReasoning: false }, { kind: "final" });

    const delivered = String(mockClient.replyStream.mock.calls[0]?.[2] ?? "");
    expect(delivered).toContain("开头说明");
    expect(delivered).toContain("中间过渡");
    expect(delivered).toContain("结尾结论");
    expect(delivered.match(/重复观察00/g)?.length).toBe(1);
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
    await flushPromises();
    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(800);
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
    await flushPromises();
    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(800);
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
      markdown: { content: "最终回复" },
    });
    expect(onFail).not.toHaveBeenCalled();
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

  it("pushes only the continuation when a frozen preview is later superseded", async () => {
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
    const pushed = String((mockClient.sendMessage.mock.calls[0]?.[1] as any).markdown.content);
    expect(pushed).toContain("继续输出：");
    expect(pushed).toContain("后续最终内容");
    expect(pushed).not.toContain("预览内容000。");
    expect(pushed).toContain("预览内容390。");
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
      markdown: { content: "最终回复" },
    });
    expect(onFail).toHaveBeenCalledWith(pushError);
    expect(onDeliver).not.toHaveBeenCalled();

    mockClient.replyStream.mockRejectedValueOnce(expiredError);

    await handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockClient.sendMessage).toHaveBeenLastCalledWith("alice", {
      msgtype: "markdown",
      markdown: { content: "最终回复" },
    });
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onDeliver).toHaveBeenCalledTimes(1);
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
});
