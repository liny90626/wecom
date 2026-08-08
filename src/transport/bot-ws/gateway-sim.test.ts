import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { __resetBotWsReplyTestState, createBotWsReplyHandle } from "./reply.js";
import { uploadAndSendBotWsMedia } from "./media.js";
import { dispatchRuntimeReply } from "../../runtime/reply-orchestrator.js";
import { asWsClient, WecomGatewaySim } from "../../test-utils/wecom-gateway-sim.js";
import type { ReplyHandle } from "../../types/index.js";

vi.mock("./media.js", () => ({
  uploadAndSendBotWsMedia: vi.fn(async () => ({ ok: true, messageId: "media-1" })),
}));

vi.setConfig({ testTimeout: 30_000 });

type Frame = Parameters<typeof createBotWsReplyHandle>[0]["frame"];

const buildFrame = (reqId: string): Frame =>
  ({
    headers: { req_id: reqId },
    body: { from: { userid: "user-1" } },
    cmd: "aibot_msg_callback",
  }) as unknown as Frame;

const flush = async (times = 12) => {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
};

const tick = async (ms: number) => {
  await flush();
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

/**
 * `deliver` awaits gateway ACKs, and those only settle once fake time moves, so
 * every delivery has to be raced against the clock instead of awaited first.
 */
const deliverAndTick = async (
  handle: ReplyHandle,
  payload: Parameters<ReplyHandle["deliver"]>[0],
  info: Parameters<ReplyHandle["deliver"]>[1],
  ms: number,
): Promise<void> => {
  let settled = false;
  const delivery = handle.deliver(payload, info).finally(() => {
    settled = true;
  });
  await tick(ms);
  // A dropped ACK holds the delivery until the SDK's 5 s timeout fires, so keep
  // the simulated clock moving until it settles instead of deadlocking.
  for (let i = 0; i < 20 && !settled; i += 1) {
    await tick(1_000);
  }
  await delivery;
};

/**
 * These run the real reply handle against a faithful model of the WeCom SDK's
 * per-req_id serial ACK queue, which is the only way the reported field
 * symptoms (no thinking blocks, a bare error where the progress was, a stray
 * "Something went wrong") reproduce at all.
 */
describe("WeCom gateway simulation", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    __resetBotWsReplyTestState();
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/wecom-sim-state");
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: { loadConfig: () => ({ channels: { wecom: {} } }) },
    } as never);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const startTurn = (sim: WecomGatewaySim, reqId = "req-sim"): ReplyHandle => {
    const handle = createBotWsReplyHandle({
      client: asWsClient(sim),
      frame: buildFrame(reqId),
      accountId: "default",
      inboundKind: "text",
      deferActivation: true,
    });
    handle.startPlaceholder?.();
    handle.activate?.();
    return handle;
  };

  it("models a late req_id ACK settling the SDK's newer queue head", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 6_000 });
    const frame = buildFrame("req-late-ack");
    const first = sim.replyStream(frame, "stream-late-ack", "第一帧", false).then(
      () => undefined,
      (error) => error,
    );
    const second = sim.replyStream(frame, "stream-late-ack", "第二帧", false);

    await tick(5_000);
    await expect(first).resolves.toBeInstanceOf(Error);

    await tick(1_000);
    await expect(second).resolves.toEqual({ errcode: 0 });
    expect(sim.streamBubble("req-late-ack")?.content).toBe("第一帧");

    await tick(5_000);
    expect(sim.streamBubble("req-late-ack")?.content).toBe("第二帧");
  });

  const bubbleRevisions = (sim: WecomGatewaySim): string[] => {
    const bubble = sim.streamBubble("req-sim");
    return bubble?.kind === "stream" ? bubble.history : [];
  };

  it("streams thinking, progress and the answer into one bubble", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);
    expect(sim.streamBubble("req-sim")?.content).toContain("正在思考中");

    await deliverAndTick(handle, { text: "读取仓库结构", isReasoning: true }, { kind: "block" }, 200);
    await tick(3_000);
    await deliverAndTick(handle, { text: "分析依赖关系", isReasoning: true }, { kind: "block" }, 200);
    await tick(2_000);
    await deliverAndTick(handle, { text: "先说结论：" }, { kind: "block" }, 200);
    await tick(2_000);
    await deliverAndTick(handle, { text: "先说结论：改动可行。" }, { kind: "final" }, 1_000);

    const bubble = sim.streamBubble("req-sim");
    expect(bubble?.closed).toBe(true);
    expect(bubble?.content).toContain("改动可行");
    expect(bubbleRevisions(sim).some((text) => text.includes("<think>分析依赖关系") ||
      text.includes("分析依赖关系</think>"))).toBe(true);
    expect(sim.chat.filter((entry) => entry.kind === "push")).toHaveLength(0);
  });

  it("keeps streaming thinking after a single lost ACK", async () => {
    // Frame 1 is the placeholder, frame 2 the first thinking snapshot. Losing
    // one ACK used to retire the progress lane for the whole turn: the user
    // then watched "正在思考中" for minutes and got the answer as a new message.
    const sim = new WecomGatewaySim({ ackLatencyMs: 60, dropAckOnSend: [2] });
    const handle = startTurn(sim);
    await tick(100);

    await deliverAndTick(handle, { text: "第一步：读取代码", isReasoning: true }, { kind: "block" }, 200);
    await tick(6_000);
    for (let i = 0; i < 5; i += 1) {
      await deliverAndTick(
        handle,
        { text: `第${i + 2}步：继续分析`, isReasoning: true },
        { kind: "block" },
        4_000,
      );
    }
    await deliverAndTick(handle, { text: "答案正文开始" }, { kind: "block" }, 4_000);

    const revisions = bubbleRevisions(sim);
    expect(revisions.some((text) => text.includes("第6步：继续分析"))).toBe(true);
    expect(revisions.at(-1)).toContain("答案正文开始");
  });

  it("keeps streaming progress after the placeholder ACK is lost", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60, dropAckOnSend: [1] });
    const handle = startTurn(sim);
    await tick(6_000);

    await deliverAndTick(handle, { text: "思考中的内容", isReasoning: true }, { kind: "block" }, 4_000);
    await deliverAndTick(handle, { text: "正文进度" }, { kind: "block" }, 4_000);

    const revisions = bubbleRevisions(sim);
    expect(revisions.some((text) => text.includes("思考中的内容"))).toBe(true);
    expect(revisions.at(-1)).toContain("正文进度");
  });

  it("does not let a placeholder retry steal the ACK slot from queued progress", async () => {
    // The req_id has a single serial ACK slot, so queueing a progress snapshot
    // must pause placeholder retries until the real snapshot has cleared it.
    const sim = new WecomGatewaySim({ ackLatencyMs: 4_000, dropAckOnSend: [1] });
    const handle = startTurn(sim);
    await tick(4_000);
    const delivery = handle.deliver({ text: "第一段思考", isReasoning: true }, { kind: "block" });
    // The initial placeholder times out at 5 s and schedules a retry for 8 s;
    // the queued progress owns the ACK slot across that retry boundary.
    await tick(7_000);
    await delivery;

    const placeholderFrames = sim.sentFrames.filter((frame) =>
      frame.content.includes("正在思考中"),
    );
    expect(placeholderFrames).toHaveLength(1);
    expect(sim.streamBubble("req-sim")?.content).toContain("第一段思考");
  });

  it("does not let the eight-minute heartbeat steal an ACK from in-flight progress", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 2_600 });
    const handle = startTurn(sim);
    await tick(8 * 60_000 - 1_000);

    const delivery = handle.deliver(
      { text: "跨过八分钟门槛的真实进度", isReasoning: true },
      { kind: "block" },
    );
    await tick(4_000);
    await delivery;

    const placeholderFrames = sim.sentFrames.filter((frame) =>
      frame.content.includes("正在思考中"),
    );
    expect(placeholderFrames).toHaveLength(1);
    expect(sim.sentFrames).toHaveLength(2);
    expect(sim.streamBubble("req-sim")?.content).toContain("跨过八分钟门槛的真实进度");

    await tick(15_000);
    expect(sim.sentFrames).toHaveLength(3);
    expect(sim.sentFrames.at(-1)?.content).toContain("跨过八分钟门槛的真实进度");
    expect(sim.sentFrames.at(-1)?.content).toContain(
      "【长任务处理中，请勿打断，已用时8m16s】",
    );
  });

  it("still retires the lane and falls back to background notices on a dead stream", async () => {
    // 846608 is WeCom closing the ~6-minute stream window. That one really is
    // unrecoverable, so the lane must retire and the deferred background push
    // must take over — splitting missing ACKs out must not weaken this.
    const sim = new WecomGatewaySim({
      ackLatencyMs: 60,
      rejectOnSend: [{ index: 2, errcode: 846608, errmsg: "stream message update expired" }],
    });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(handle, { text: "长任务进度", isReasoning: true }, { kind: "block" }, 500);

    expect(sim.streamBubble("req-sim")?.content).toContain("正在思考中");
    // The shared 8-minute gate filters short tasks before the first background push.
    expect(sim.chat.filter((entry) => entry.kind === "push")).toHaveLength(0);
    await tick(8 * 60_000);
    const pushes = sim.chat.filter((entry) => entry.kind === "push");
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    expect(pushes[0]?.content).toBe("【长任务处理中，请勿打断，已用时8m00s】");
  });

  it("keeps the reasoning visible when the turn ends in an error", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(handle, { text: "正在检索超长上下文", isReasoning: true }, { kind: "block" }, 3_500);
    await deliverAndTick(
      handle,
      { text: "继续检索，调用了 12 个工具", isReasoning: true },
      { kind: "block" },
      3_500,
    );
    await deliverAndTick(
      handle,
      { text: "LLM request timed out.", isError: true },
      { kind: "final" },
      2_000,
    );

    const bubble = sim.streamBubble("req-sim");
    expect(bubble?.closed).toBe(true);
    expect(bubble?.content).toContain("LLM request timed out.");
    // The whole point: the failure must not erase the work the user watched.
    expect(bubble?.content).toContain("正在检索超长上下文");
    expect(bubble?.content).toContain("继续检索，调用了 12 个工具");
  });

  it("does not fragment a long error final just because reasoning rides along", async () => {
    // The reasoning prefix must come out of the frame's leftover room, never
    // out of the answer's chunk size — shrinking that splits the remainder into
    // extra push messages spaced 800 ms apart.
    const longBody = "结论段落。".repeat(900);
    const runErrorFinal = async (thinking: string): Promise<number> => {
      const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
      const handle = startTurn(sim, `req-${thinking.length}`);
      await tick(100);
      if (thinking) {
        await deliverAndTick(handle, { text: thinking, isReasoning: true }, { kind: "block" }, 200);
      }
      await deliverAndTick(handle, { text: longBody, isError: true }, { kind: "final" }, 2_000);
      for (let i = 0; i < 12; i += 1) {
        await tick(800);
      }
      return sim.chat.filter((entry) => entry.kind === "push").length;
    };

    const withoutThinking = await runErrorFinal("");
    const withThinking = await runErrorFinal("推理过程。".repeat(600));
    expect(withThinking).toBe(withoutThinking);
  });

  it("falls back to background notices when the gateway stops acknowledging", async () => {
    // A stream that never ACKs again may also have stopped rendering, so the
    // deferred push is the only feedback the user can still get.
    const sim = new WecomGatewaySim({
      ackLatencyMs: 60,
      dropAckOnSend: Array.from({ length: 40 }, (_, index) => index + 2),
    });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(handle, { text: "长任务进度", isReasoning: true }, { kind: "block" }, 500);

    expect(sim.chat.filter((entry) => entry.kind === "push")).toHaveLength(0);
    await tick(8 * 60_000);
    const pushes = sim.chat.filter((entry) => entry.kind === "push");
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    expect(pushes[0]?.content).toBe("【长任务处理中，请勿打断，已用时8m00s】");
  });

  it("does not arm background notices after a single recovered ACK hiccup", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60, dropAckOnSend: [2] });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(handle, { text: "第一步", isReasoning: true }, { kind: "block" }, 200);
    await tick(6_000);
    await deliverAndTick(handle, { text: "第二步", isReasoning: true }, { kind: "block" }, 4_000);
    handle.markExternalActivity?.();

    await tick(10 * 60_000);
    expect(sim.chat.filter((entry) => entry.kind === "push")).toHaveLength(0);
  });

  it("carries new progress out with the background notice instead of dropping it", async () => {
    // Once the stream window closes the bubble can no longer be repainted, but
    // the agent keeps producing text. Sending only the bare status line leaves
    // the user staring at a stale bubble while real output piles up unseen.
    const sim = new WecomGatewaySim({
      ackLatencyMs: 60,
      rejectOnSend: [{ index: 3, errcode: 846608, errmsg: "stream message update expired" }],
    });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(handle, { text: "第一段进度" }, { kind: "block" }, 500);
    // Frame 3 closes the window; everything after it accumulates unseen.
    await deliverAndTick(handle, { text: "第一段进度\n第二段进度" }, { kind: "block" }, 2_000);
    await deliverAndTick(handle, { text: "第一段进度\n第二段进度\n第三段进度" }, { kind: "block" }, 2_000);

    await tick(8 * 60_000);
    const notice =
      sim.chat.find(
        (entry) => entry.kind === "push" && entry.content.includes("第三段进度"),
      )?.content ?? "";
    expect(notice).toContain("第三段进度");
    expect(notice).toContain("【长任务处理中，请勿打断，已用时8m00s】");

    await deliverAndTick(
      handle,
      { text: "第一段进度\n第二段进度\n第三段进度\n最终答案" },
      { kind: "final" },
      3_000,
    );
    const finalPush = sim.chat.filter((entry) => entry.kind === "push").at(-1)?.content ?? "";
    expect(finalPush).toContain("最终答案");
    // What the background notice already delivered must not be repeated.
    expect(finalPush).not.toContain("第三段进度");
  });

  it("carries new narration after the stream window expires", async () => {
    const sim = new WecomGatewaySim({
      ackLatencyMs: 60,
      rejectOnSend: [{ index: 2, errcode: 846608, errmsg: "stream message update expired" }],
    });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(
      handle,
      {
        text: "正在分析文件",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
      500,
    );
    await deliverAndTick(
      handle,
      {
        text: "文件分析失败，正在回退",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
      500,
    );

    await tick(8 * 60_000);
    const statusPushes = sim.chat.filter((entry) => entry.kind === "push");
    expect(statusPushes[0]?.content).toContain("文件分析失败，正在回退");
    expect(statusPushes[0]?.content).toContain(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );

    await tick(15_000);
    const repeatedStatusPushes = sim.chat.filter((entry) => entry.kind === "push");
    expect(repeatedStatusPushes).toHaveLength(2);
    const nextStatus = repeatedStatusPushes[1]?.content ?? "";
    expect(nextStatus).not.toContain("文件分析失败，正在回退");

    await deliverAndTick(handle, { text: "最终答案" }, { kind: "final" }, 3_000);
    const finalPush = sim.chat.filter((entry) => entry.kind === "push").at(-1)?.content ?? "";
    expect(finalPush).toContain("最终答案");
    expect(finalPush).not.toContain("文件分析");
  });

  it("preserves interleaved narration and Fast progress after stream death", async () => {
    const sim = new WecomGatewaySim({
      ackLatencyMs: 60,
      rejectOnSend: [{ index: 2, errcode: 846608, errmsg: "stream message update expired" }],
    });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(
      handle,
      {
        text: "正在读取依赖清单",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
      500,
    );
    await deliverAndTick(
      handle,
      {
        text: "正在核对依赖",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
      500,
    );
    await deliverAndTick(
      handle,
      {
        text: "Fast: auto-off(62s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      },
      { kind: "block" },
      500,
    );

    await tick(8 * 60_000);
    const progressPush = sim.chat.find((entry) => entry.kind === "push")?.content ?? "";
    // Narration is a current-step snapshot: the newest value is what ships.
    expect(progressPush).not.toContain("正在读取依赖清单");
    expect(progressPush).toContain("正在核对依赖");
    expect(progressPush).toContain("Fast: auto-off(62s>=60s)");
    expect(progressPush).toContain("【长任务处理中，请勿打断");
  });

  it("keeps body and transient bookmarks independent across a dead stream", async () => {
    const sim = new WecomGatewaySim({
      ackLatencyMs: 60,
      rejectOnSend: [{ index: 4, errcode: 846608, errmsg: "stream message update expired" }],
    });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(handle, { text: "已显示正文。" }, { kind: "block" }, 700);
    await deliverAndTick(
      handle,
      {
        text: "正在执行依赖检查",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
      700,
    );
    expect(sim.streamBubble("req-sim")?.content).toContain("已显示正文。");
    expect(sim.streamBubble("req-sim")?.content).toContain("正在执行依赖检查");

    // This body revision closes the stream. The next structured state can no
    // longer repaint the bubble and must travel with the background notice.
    await deliverAndTick(handle, { text: "新增正文。" }, { kind: "block" }, 700);
    await deliverAndTick(
      handle,
      {
        text: "依赖检查失败",
        channelData: { openclawProgressKind: "preamble" },
      },
      { kind: "block" },
      700,
    );

    await tick(8 * 60_000);
    const firstPush = sim.chat.find((entry) => entry.kind === "push");
    expect(firstPush?.content).toContain("新增正文。");
    expect(firstPush?.content).not.toContain("已显示正文。");
    expect(firstPush?.content).toContain("依赖检查失败");
    expect(firstPush?.content).toContain("【长任务处理中，请勿打断");

    await tick(15_000);
    const statusPushes = sim.chat.filter((entry) => entry.kind === "push");
    expect(statusPushes).toHaveLength(2);
    expect(statusPushes[1]?.content).not.toContain("新增正文。");
    expect(statusPushes[1]?.content).not.toContain("依赖检查失败");

    await deliverAndTick(handle, { text: "最终结论。" }, { kind: "final" }, 3_000);
    const finalPush = sim.chat.filter((entry) => entry.kind === "push").at(-1)?.content ?? "";
    expect(finalPush).toContain("最终结论。");
    expect(finalPush).not.toContain("新增正文。");
    expect(finalPush).not.toContain("依赖检查失败");
  });

  it("keeps a zero-output long task alive in the bubble and then on the push", async () => {
    // The reported case: a tool-only turn. Reasoning defaults to "off" in
    // OpenClaw (`reasoningMode ?? "off"`), so onReasoningStream never fires, and
    // a turn that produces no assistant text never emits a block either — the
    // plugin gets NO progress callback at all for ten minutes. Every feedback
    // path was gated on content: the placeholder repeated one static line and
    // died at 120 s, the frozen status needed a rendered preview, and the
    // background notice was only ever armed by a FAILED preview send. So the
    // user saw "正在思考..." and then, ten minutes later, a failure.
    const sim = new WecomGatewaySim({ ackLatencyMs: 60, rejectAfterMs: 6 * 60_000 });
    const handle = startTurn(sim);
    await tick(100);
    expect(sim.streamBubble("req-sim")?.content).toContain("正在思考中");

    // A healthy placeholder ACK is sufficient feedback before the shared
    // long-task gate; no static keepalive frames should be emitted meanwhile.
    await tick(8 * 60_000 - 101);
    expect(sim.sentFrames).toHaveLength(1);
    expect(sim.chat.filter((entry) => entry.kind === "push")).toHaveLength(0);

    // At eight minutes the ~6-minute stream is no longer repaintable, so the
    // background lane takes over with the same long-task status.
    await tick(100);
    const pushes = sim.chat.filter((entry) => entry.kind === "push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.content).toBe("【长任务处理中，请勿打断，已用时8m00s】");
  });

  it("waits eight minutes before showing silent-task status and then refreshes every 15 seconds", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    startTurn(sim);
    await tick(100);

    expect(sim.sentFrames).toHaveLength(1);
    expect(sim.streamBubble("req-sim")?.content).toContain("正在思考中");

    await tick(8 * 60_000 - 101);
    expect(sim.sentFrames).toHaveLength(1);

    await tick(1);
    expect(sim.sentFrames).toHaveLength(2);
    expect(sim.sentFrames.at(-1)?.content).toBe(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );

    await tick(14_999);
    expect(sim.sentFrames).toHaveLength(2);
    await tick(1);
    expect(sim.sentFrames).toHaveLength(3);
    expect(sim.sentFrames.at(-1)?.content).toBe(
      "【长任务处理中，请勿打断，已用时8m15s】",
    );
  });

  it("moves a silent task to the 15-second push cadence when its long-task heartbeat loses ACK", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60, dropAckOnSend: [2, 3, 4] });
    startTurn(sim);
    await tick(100);
    await tick(8 * 60_000 - 100);

    expect(sim.sentFrames).toHaveLength(2);
    expect(sim.chat.filter((entry) => entry.kind === "push")).toHaveLength(0);

    await tick(5_000);
    const statusPushes = () => sim.chat.filter((entry) => entry.kind === "push");
    expect(statusPushes()).toHaveLength(1);
    expect(statusPushes()[0]?.content).toBe(
      "【长任务处理中，请勿打断，已用时8m05s】",
    );

    await tick(14_999);
    expect(statusPushes()).toHaveLength(1);
    await tick(1);
    expect(statusPushes()).toHaveLength(2);
    expect(statusPushes()[1]?.content).toBe(
      "【长任务处理中，请勿打断，已用时8m20s】",
    );
    expect(sim.sentFrames).toHaveLength(2);
  });

  it("does not label a fast large preview as a long task before eight minutes", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(handle, { text: "真实过程。".repeat(700) }, { kind: "block" }, 500);

    expect(sim.streamBubble("req-sim")?.content).toContain("真实过程。");
    expect(sim.streamBubble("req-sim")?.content).not.toContain("长任务处理中");

    await tick(8 * 60_000 - 601);
    expect(sim.streamBubble("req-sim")?.content).not.toContain("长任务处理中");

    await tick(100);
    expect(sim.streamBubble("req-sim")?.content).toContain(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );
    const frameCountAtEightMinutes = sim.sentFrames.length;

    await tick(15_000);
    expect(sim.sentFrames).toHaveLength(frameCountAtEightMinutes + 1);
    expect(sim.sentFrames.at(-1)?.content).toContain(
      "【长任务处理中，请勿打断，已用时8m15s】",
    );
  });

  it("shows frozen-preview status at the absolute eight-minute gate after a late preview", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);
    await tick(8 * 60_000 - 1_200);
    await deliverAndTick(handle, { text: "临近门槛的正文。".repeat(700) }, { kind: "block" }, 100);

    expect(sim.streamBubble("req-sim")?.content).not.toContain("长任务处理中");
    await tick(1_000);
    await tick(60);

    expect(sim.streamBubble("req-sim")?.content).toContain(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );
  });

  it("takes over an expired silent stream at eight minutes with the same 15-second cadence", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60, rejectAfterMs: 6 * 60_000 });
    startTurn(sim);
    await tick(8 * 60_000 - 1);
    expect(sim.chat.filter((entry) => entry.kind === "push")).toHaveLength(0);

    await tick(100);
    const statusPushes = () => sim.chat.filter((entry) => entry.kind === "push");
    expect(statusPushes()).toHaveLength(1);
    expect(statusPushes()[0]?.content).toBe(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );

    await tick(15_000);
    expect(statusPushes()).toHaveLength(2);
    expect(statusPushes()[1]?.content).toBe(
      "【长任务处理中，请勿打断，已用时8m15s】",
    );
  });

  it("keeps a silent long task's clock running after an external message", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(8 * 60_000 + 100);
    const beforeExternal = sim.streamBubble("req-sim")?.content ?? "";
    expect(beforeExternal).toBe("【长任务处理中，请勿打断，已用时8m00s】");

    handle.markExternalActivity?.();
    const framesBeforeExternal = sim.sentFrames.length;
    await tick(14_999);
    expect(sim.sentFrames).toHaveLength(framesBeforeExternal);
    await tick(1);
    expect(sim.sentFrames).toHaveLength(framesBeforeExternal + 1);
    expect(sim.sentFrames.at(-1)?.content).toBe(
      "【长任务处理中，请勿打断，已用时8m15s】",
    );
  });

  it("never lets the heartbeat overwrite real progress", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(2 * 60_000);
    await deliverAndTick(handle, { text: "真正的进度", isReasoning: true }, { kind: "block" }, 500);
    // An external message reschedules the cadence; the bubble must stay on the
    // progress the preview lane rendered.
    handle.markExternalActivity?.();
    await tick(2 * 60_000);
    expect(sim.streamBubble("req-sim")?.content).toContain("真正的进度");
  });

  it("keeps the background notice cadence after an external message", async () => {
    // Any active push on this peer (a spawned task's completion is the common
    // one) marks external activity. Retiring the whole notice cadence there
    // silences the running long task for the rest of its turn.
    const sim = new WecomGatewaySim({
      ackLatencyMs: 60,
      rejectOnSend: [{ index: 2, errcode: 846608, errmsg: "stream message update expired" }],
    });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(handle, { text: "长任务进度", isReasoning: true }, { kind: "block" }, 500);
    await tick(8 * 60_000);
    const beforeExternal = sim.chat.filter((entry) => entry.kind === "push").length;
    expect(beforeExternal).toBe(1);

    handle.markExternalActivity?.();
    // The external message just reached the user, so nothing right away...
    await tick(14_999);
    expect(sim.chat.filter((entry) => entry.kind === "push")).toHaveLength(beforeExternal);
    // ...but the cadence must come back.
    await tick(1);
    const pushes = sim.chat.filter((entry) => entry.kind === "push");
    expect(pushes).toHaveLength(beforeExternal + 1);
    expect(pushes.at(-1)?.content).toBe(
      "【长任务处理中，请勿打断，已用时8m15s】",
    );
  });

  it("keeps refreshing the frozen bubble status after an external message", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);
    // Over the freeze threshold, so the bubble switches to status refreshes.
    await deliverAndTick(handle, { text: "进度。".repeat(1_200) }, { kind: "block" }, 500);
    await tick(8 * 60_000);
    const beforeExternal = sim.sentFrames.length;
    expect(sim.sentFrames.at(-1)?.content).toContain(
      "【长任务处理中，请勿打断，已用时8m00s】",
    );

    handle.markExternalActivity?.();
    // The existing status interval keeps its phase; after external activity it
    // skips the next tick and paints on the following one.
    await tick(15_000);
    expect(sim.sentFrames).toHaveLength(beforeExternal);
    await tick(15_000);
    expect(sim.sentFrames.length).toBeGreaterThan(beforeExternal);
    expect(sim.sentFrames.at(-1)?.content).toContain(
      "【长任务处理中，请勿打断，已用时8m30s】",
    );
  });

  it("carries real narration — and nothing else — through the gateway before failure", async () => {
    vi.useRealTimers();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    const sim = new WecomGatewaySim({ ackLatencyMs: 10 });
    const handle = createBotWsReplyHandle({
      client: asWsClient(sim),
      frame: buildFrame("req-real-openclaw-progress"),
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });
    const { dispatchReplyWithBufferedBlockDispatcher: realDispatch } = await import(
      "openclaw/plugin-sdk/reply-runtime"
    );

    await dispatchRuntimeReply({
      core: {
        channel: {
          reply: {
            dispatchReplyWithBufferedBlockDispatcher: (params: any) =>
              realDispatch({
                ...params,
                replyResolver: async (_ctx, options) => {
                  await options.onItemEvent?.({
                    itemId: "commentary-gateway-real-1",
                    kind: "preamble",
                    progressText: "正在核对网关超时边界",
                  });
                  await options.onItemEvent?.({
                    itemId: "command:gateway-real-1",
                    toolCallId: "gateway-real-1",
                    kind: "command",
                    name: "exec",
                    phase: "start",
                    status: "running",
                    title: "cat /private/gateway-secret",
                    progressText: "GATEWAY_SECRET_OUTPUT",
                  });
                  return { text: "LLM request failed.", isError: true };
                },
              }),
          },
        },
      } as any,
      cfg: {} as any,
      session: {
        ctx: {
          Body: "执行长任务",
          RawBody: "执行长任务",
          CommandBody: "执行长任务",
          From: "user-real-gateway",
          To: "wecom-bot",
          SessionKey: "agent:main:wecom:direct:user-real-gateway",
          Provider: "wecom",
          Surface: "wecom",
          ChatType: "direct",
          AccountId: "default",
          MessageSid: "msg-real-gateway",
        },
      } as any,
      replyHandle: handle,
    });

    const bubble = sim.streamBubble("req-real-openclaw-progress");
    const history = bubble?.kind === "stream" ? bubble.history : [];
    const progressIndex = history.findIndex((text) => text.includes("正在核对网关超时边界"));
    const finalIndex = history.findIndex((text) => text.includes("LLM request failed."));
    const renderedHistory = history.join("\n");
    expect(progressIndex).toBeGreaterThanOrEqual(0);
    expect(finalIndex).toBeGreaterThan(progressIndex);
    // The tool item travelled the same callback and produced no frame at all.
    expect(renderedHistory).not.toMatch(/Exec|Tool Call|🧰|🛠/);
    expect(renderedHistory).not.toContain("/private/gateway-secret");
    expect(renderedHistory).not.toContain("GATEWAY_SECRET_OUTPUT");
  });

  it("gives a failed long task context instead of one bare provider line", async () => {
    // The reported case: a long task whose work was all tool calls (no visible
    // body), whose ~6-minute stream window has closed, then fails. The final
    // has to leave on the push route, where it used to arrive as nothing but
    // "LLM request failed." with no hint of what ran or for how long.
    const sim = new WecomGatewaySim({
      ackLatencyMs: 60,
      rejectOnSend: [{ index: 2, errcode: 846608, errmsg: "stream message update expired" }],
    });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(handle, { text: "调用第 1 个工具", isReasoning: true }, { kind: "block" }, 500);
    await tick(11 * 60_000);

    await deliverAndTick(
      handle,
      { text: "LLM request failed.", isError: true },
      { kind: "final" },
      3_000,
    );

    const pushes = sim.chat.filter((entry) => entry.kind === "push");
    const finalPush = pushes.at(-1)?.content ?? "";
    expect(finalPush).toContain("LLM request failed.");
    expect(finalPush).not.toBe("LLM request failed.");
    // Elapsed time and an explicit "did not finish" framing, in the user's language.
    expect(finalPush).toContain("未完成");
    expect(finalPush).toMatch(/1[01]m\d{2}s/);
  });

  it("never pushes a superseded turn's core failure text as a new message", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(handle, { text: "思考中", isReasoning: true }, { kind: "block" }, 200);

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      reason: "new-inbound",
    });
    await tick(200);

    await deliverAndTick(
      handle,
      {
        text: "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
        isError: true,
      },
      { kind: "final" },
      3_000,
    );

    expect(sim.visibleText().join("\n")).not.toContain("Something went wrong");
    expect(sim.streamBubble("req-sim")?.content).toContain("已收到新消息");
  });

  it("still delivers media on a superseded error final", async () => {
    // The failure-copy suppression must not swallow an artifact the run
    // produced; that path keeps the normal superseded handling.
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);
    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      reason: "new-inbound",
    });
    await tick(200);
    await deliverAndTick(
      handle,
      { text: "⚠️ Something went wrong while processing your request.", isError: true,
        mediaUrls: ["/tmp/report.pdf"] },
      { kind: "final" },
      3_000,
    );

    expect(vi.mocked(uploadAndSendBotWsMedia)).toHaveBeenCalledTimes(1);
  });

  it("still pushes a superseded turn's real answer as a new message", async () => {
    // The error-only suppression must not swallow an actual result.
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);
    await deliverAndTick(handle, { text: "思考中", isReasoning: true }, { kind: "block" }, 200);

    handle.supersedeByNewInbound?.({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      reason: "new-inbound",
    });
    await tick(200);
    await deliverAndTick(handle, { text: "旧任务的真实答案" }, { kind: "final" }, 3_000);

    expect(sim.visibleText().join("\n")).toContain("旧任务的真实答案");
  });
});
