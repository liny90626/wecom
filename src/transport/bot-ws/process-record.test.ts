import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { __resetBotWsReplyTestState, createBotWsReplyHandle } from "./reply.js";
import { dispatchRuntimeReply } from "../../runtime/reply-orchestrator.js";
import { asWsClient, WecomGatewaySim } from "../../test-utils/wecom-gateway-sim.js";
import type { ReplyHandle } from "../../types/index.js";

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
 * 现网反馈：「8 分钟以内的长任务，虽然消息在刷，但每一条都在 agent 发送的原
 * 气泡上覆盖刷写，过程没有正确记录和回复」。根因是过程文字被建模成可变状态
 * （只存当前步骤，帧帧覆盖，final 不含它），而 OpenClaw 源头本来就把自述作为
 * 一次性有序段落发射。修复后过程是一份追加式步骤日志：气泡内步骤编号追加显
 * 示，final 送达后未持久化的步骤作为「📋 本轮过程记录」推送落档。
 */
describe("长任务过程记录（真实 orchestrator + 网关模拟）", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    __resetBotWsReplyTestState();
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/wecom-process-record-state");
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

  const runTurn = async (
    handle: ReplyHandle,
    body: (options: {
      onItemEvent: (payload: Record<string, unknown>) => Promise<void> | void;
      deliverFinal: (payload: Record<string, unknown>) => Promise<void>;
    }) => Promise<void>,
  ): Promise<void> => {
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async (params: any) => {
        await body({
          onItemEvent: (payload) => params.replyOptions.onItemEvent(payload),
          deliverFinal: async (payload) => {
            const delivery = params.dispatcherOptions.deliver(payload, { kind: "final" });
            await tick(3_000);
            await delivery;
          },
        });
        return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
      });
    let settled = false;
    const dispatched = dispatchRuntimeReply({
      core: { channel: { reply: { dispatchReplyWithBufferedBlockDispatcher } } } as any,
      cfg: {} as any,
      session: { ctx: { SessionKey: "session-process-record" } } as any,
      replyHandle: handle,
    }).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 40 && !settled; i += 1) {
      await tick(500);
    }
    await dispatched;
    // The record flush is a post-final push; give it time to settle.
    await tick(2_000);
  };

  const bubbleRevisions = (sim: WecomGatewaySim, reqId = "req-sim"): string[] => {
    const bubble = sim.streamBubble(reqId);
    return bubble?.kind === "stream" ? bubble.history : [];
  };

  const pushContents = (sim: WecomGatewaySim): string[] =>
    sim.chat.filter((entry) => entry.kind === "push").map((entry) => entry.content);

  const STEPS = [
    "先确认发布门禁配置",
    "门禁正常，检查最近一次运行记录",
    "运行记录缺少上下文，展开任务定义",
    "任务定义无异常，正在整理结论",
  ];
  const ANSWER = "结论：超时来自网关代理，已给出修复建议。";

  it("4 分钟 4 步骤：气泡步骤追加、final 只留答案、过程记录随收尾落档", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);

    await runTurn(handle, async ({ onItemEvent, deliverFinal }) => {
      for (const [index, step] of STEPS.entries()) {
        await tick(30_000);
        await onItemEvent({
          itemId: `commentary-run-${index + 1}`,
          kind: "preamble",
          progressText: step,
        });
        await tick(30_000);
      }
      await deliverFinal({ text: ANSWER });
    });

    const history = bubbleRevisions(sim);
    // 步骤在气泡内追加，而不是互相覆盖：出现第 2 步的帧里第 1 步仍在。
    const frameWithStep2 = history.find((text) => text.includes(STEPS[1]!));
    expect(frameWithStep2).toBeDefined();
    expect(frameWithStep2).toContain(`1）${STEPS[0]}`);
    expect(frameWithStep2).toContain(`2）${STEPS[1]}`);
    const lastProgressFrame = history.filter((text) => text.includes("1）")).at(-1) ?? "";
    for (const [index, step] of STEPS.entries()) {
      expect(lastProgressFrame).toContain(`${index + 1}）${step}`);
    }

    // final 收口后气泡只保留答案。
    const bubble = sim.streamBubble("req-sim");
    expect(bubble?.closed).toBe(true);
    expect(bubble?.content).toBe(ANSWER);

    // 过程记录作为一条持久推送落档：标题 + 全部步骤，每步恰好一次。
    const pushes = pushContents(sim);
    expect(pushes).toHaveLength(1);
    const record = pushes[0]!;
    expect(record).toContain("📋 本轮过程记录");
    expect(record).toContain("共 4 步");
    for (const [index, step] of STEPS.entries()) {
      expect(record.split(step)).toHaveLength(2);
      expect(record).toContain(`${index + 1}）${step}`);
    }
    // 记录按步骤顺序排列。
    const positions = STEPS.map((step) => record.indexOf(step));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("不足 2 分钟的短回合：气泡内照样追加，但收尾不推记录", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);

    await runTurn(handle, async ({ onItemEvent, deliverFinal }) => {
      await tick(10_000);
      await onItemEvent({
        itemId: "commentary-short-1",
        kind: "preamble",
        progressText: "正在查询数据",
      });
      await tick(10_000);
      await onItemEvent({
        itemId: "commentary-short-2",
        kind: "preamble",
        progressText: "已取得结果，整理中",
      });
      await tick(10_000);
      await deliverFinal({ text: "查询完成：共 3 条。" });
    });

    const history = bubbleRevisions(sim);
    expect(
      history.some(
        (text) => text.includes("1）正在查询数据") && text.includes("2）已取得结果，整理中"),
      ),
    ).toBe(true);
    expect(pushContents(sim)).toHaveLength(0);
    expect(sim.streamBubble("req-sim")?.content).toBe("查询完成：共 3 条。");
  });

  it("相邻 item 同文只成一步；该 item 随后分化成为新步骤（v6 形态）", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);

    await runTurn(handle, async ({ onItemEvent, deliverFinal }) => {
      await onItemEvent({
        itemId: "commentary-dup-1",
        kind: "preamble",
        progressText: "正在评估终止风险",
      });
      await tick(2_000);
      await onItemEvent({
        itemId: "commentary-dup-2",
        kind: "preamble",
        progressText: "正在评估终止风险",
      });
      await tick(2_000);
      await onItemEvent({
        itemId: "commentary-dup-2",
        kind: "preamble",
        progressText: "终止风险评估完成",
      });
      await tick(2_000);
      await deliverFinal({ text: "任务已终止" });
    });

    const history = bubbleRevisions(sim);
    // 同文重复的两条 item 只显示一步。
    for (const frame of history) {
      expect(frame.split("正在评估终止风险").length - 1).toBeLessThanOrEqual(1);
    }
    // 分化后的文本成为第 2 步，而不是改写第 1 步。
    expect(
      history.some(
        (text) => text.includes("1）正在评估终止风险") && text.includes("2）终止风险评估完成"),
      ),
    ).toBe(true);
  });

  it("前缀延续（自述被 flush 边界切开）合并为同一步", async () => {
    const sim = new WecomGatewaySim({ ackLatencyMs: 60 });
    const handle = startTurn(sim);
    await tick(100);

    await runTurn(handle, async ({ onItemEvent, deliverFinal }) => {
      await onItemEvent({
        itemId: "commentary-cont-1",
        kind: "preamble",
        progressText: "正在检查配置",
      });
      await tick(2_000);
      await onItemEvent({
        itemId: "commentary-cont-2",
        kind: "preamble",
        progressText: "正在检查配置文件并对比默认值",
      });
      await tick(2_000);
      await deliverFinal({ text: "配置一致。" });
    });

    const history = bubbleRevisions(sim);
    expect(history.some((text) => text.includes("1）正在检查配置文件并对比默认值"))).toBe(true);
    expect(history.every((text) => !text.includes("2）"))).toBe(true);
  });

  it("流窗死亡后步骤随状态推送落档，收尾不再重复推记录", async () => {
    // 1 分钟后流窗关闭（846608）。此前 2 步进过气泡，此后 2 步只能走推送。
    // 推送通道从 durable 书签补齐：首条通知会带全 4 步（编号连续），此后
    // 收尾时已无剩余步骤，不再追加记录推送——每一步恰好持久化一次。
    const sim = new WecomGatewaySim({ ackLatencyMs: 60, rejectAfterMs: 60_000 });
    const handle = startTurn(sim);
    await tick(100);

    await runTurn(handle, async ({ onItemEvent, deliverFinal }) => {
      await tick(10_000);
      await onItemEvent({
        itemId: "commentary-dead-1",
        kind: "preamble",
        progressText: STEPS[0],
      });
      await tick(20_000);
      await onItemEvent({
        itemId: "commentary-dead-2",
        kind: "preamble",
        progressText: STEPS[1],
      });
      // 越过流窗（60s）后气泡死亡，之后的步骤到不了气泡。
      await tick(70_000);
      await onItemEvent({
        itemId: "commentary-dead-3",
        kind: "preamble",
        progressText: STEPS[2],
      });
      await tick(60_000);
      await onItemEvent({
        itemId: "commentary-dead-4",
        kind: "preamble",
        progressText: STEPS[3],
      });
      // 走到 8 分钟门槛之后，让后台推送通道启动并送出未持久化步骤。
      await tick(6 * 60_000);
      await deliverFinal({ text: ANSWER });
    });

    const pushes = pushContents(sim);
    const joined = pushes.join("\n===\n");
    // 每一步在推送集合中恰好出现一次（通知或记录，不重复）。
    for (const step of STEPS) {
      expect(joined.split(step)).toHaveLength(2);
    }
    // 编号连续可读。
    for (const [index, step] of STEPS.entries()) {
      expect(joined).toContain(`${index + 1}）${step}`);
    }
    // 答案最终以推送到达（回执已不可信）。
    expect(joined).toContain(ANSWER);
  });
});
