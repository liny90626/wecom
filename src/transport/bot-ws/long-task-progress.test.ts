import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { __resetBotWsReplyTestState, createBotWsReplyHandle } from "./reply.js";
import { dispatchRuntimeReply } from "../../runtime/reply-orchestrator.js";
import { asWsClient, WecomGatewaySim } from "../../test-utils/wecom-gateway-sim.js";
import type { ReplyHandle } from "../../types/index.js";

vi.setConfig({ testTimeout: 30_000 });

const LONG_TASK_STATUS_PREFIX = "【长任务处理中，请勿打断，已用时";

type Frame = Parameters<typeof createBotWsReplyHandle>[0]["frame"];

const buildFrame = (reqId: string, chatKind: "direct" | "group" = "direct"): Frame =>
  ({
    headers: { req_id: reqId },
    body:
      chatKind === "group"
        ? { chattype: "group", chatid: "chat-1", from: { userid: "user-1" } }
        : { from: { userid: "user-1" } },
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
 * 长任务的过程可见性契约（真实 orchestrator → handle → 网关模拟）：
 *
 * - 过程是一份**追加式步骤日志**：气泡内按编号追加，不再互相覆盖刷写。
 * - 流窗还活着时，过程就在气泡里；收尾由答案接管，**不再补一条过程记录推送**
 *   （现网反馈：那条「共 N 步、正文只有 2 步」的记录反而让人困惑）。
 * - 流窗一死（846608），气泡永远停在最后一帧确认送达的内容——那已经是聊天
 *   记录，所以推送通道从这里往后**只送新步骤**，并且**立刻接手**，不再等回合
 *   满 8 分钟（6→8 分钟那段盲区正是「过程消息丢失」的现场）。
 */
describe("长任务过程可见性（真实 orchestrator + 网关模拟）", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    __resetBotWsReplyTestState();
    vi.stubEnv(
      "OPENCLAW_STATE_DIR",
      mkdtempSync(path.join(os.tmpdir(), "wecom-process-record-state-")),
    );
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: { current: () => ({ channels: { wecom: {} } }) },
    } as never);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const startTurn = (
    sim: WecomGatewaySim,
    reqId = "req-sim",
    chatKind: "direct" | "group" = "direct",
  ): ReplyHandle => {
    const handle = createBotWsReplyHandle({
      client: asWsClient(sim),
      frame: buildFrame(reqId, chatKind),
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
      deliverBlock: (payload: Record<string, unknown>) => Promise<void>;
      deliverFinal: (payload: Record<string, unknown>) => Promise<void>;
    }) => Promise<void>,
  ): Promise<void> => {
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async (params: any) => {
        await body({
          onItemEvent: (payload) => params.replyOptions.onItemEvent(payload),
          deliverBlock: async (payload) => {
            await params.dispatcherOptions.deliver(payload, { kind: "block" });
          },
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

  it("4 分钟 4 步骤（流窗健康）：气泡步骤追加、final 只留答案、不追加记录推送", async () => {
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

    // 气泡全程可见过程，收尾只留答案——不再额外推一条「过程记录」。
    expect(pushContents(sim)).toHaveLength(0);
  });

  it("短回合：气泡内照样追加，全程零推送", async () => {
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

  it("流窗死亡：推送立刻接手、不重复气泡里已永久的步骤、每步恰好一次", async () => {
    // 企微流窗约 6 分钟后 846608。此前的步骤留在那一帧气泡里，它此后再也不会
    // 被覆盖（final 也改不动它），所以推送只从这里往后送新步骤。
    const sim = new WecomGatewaySim({ ackLatencyMs: 60, rejectAfterMs: 6 * 60_000 });
    const handle = startTurn(sim);
    const startedAt = Date.now();
    const pushAtMs: number[] = [];
    let seenPushes = 0;
    const samplePushes = () => {
      const pushes = sim.chat.filter((entry) => entry.kind === "push");
      for (let i = seenPushes; i < pushes.length; i += 1) {
        pushAtMs.push(Date.now() - startedAt);
      }
      seenPushes = pushes.length;
    };
    await tick(100);

    const LONG_STEPS = Array.from(
      { length: 12 },
      (_, i) => `第 ${i + 1} 步：核对第 ${i + 1} 项配置`,
    );
    await runTurn(handle, async ({ onItemEvent, deliverFinal }) => {
      for (const [index, step] of LONG_STEPS.entries()) {
        await tick(45_000);
        await onItemEvent({
          itemId: `commentary-long-${index + 1}`,
          kind: "preamble",
          progressText: step,
        });
        samplePushes();
      }
      // 让最后一步也拿到它的推送名额，再收尾。
      await tick(90_000);
      samplePushes();
      await deliverFinal({ text: ANSWER });
      samplePushes();
    });
    samplePushes();

    const bubble = sim.streamBubble("req-sim");
    const frozenBubbleText = bubble?.kind === "stream" ? bubble.content : "";
    const pushes = pushContents(sim);
    const joined = pushes.join("\n===\n");

    // ① 盲区已消失：第一条推送远早于 8 分钟门槛（流窗一死就接手）。
    expect(pushAtMs[0]).toBeLessThan(8 * 60_000);

    // ② 气泡里已永久的步骤不再被推送重复一遍。
    const stepsInBubble = LONG_STEPS.filter((step) => frozenBubbleText.includes(step));
    expect(stepsInBubble.length).toBeGreaterThan(0);
    for (const step of stepsInBubble) {
      expect(joined).not.toContain(step);
    }

    // ③ 每一步恰好出现一次（气泡或推送），一步不丢、一步不重。
    for (const [index, step] of LONG_STEPS.entries()) {
      const inBubble = frozenBubbleText.split(step).length - 1;
      const inPushes = joined.split(step).length - 1;
      expect(inBubble + inPushes).toBe(1);
      if (inPushes === 1) {
        expect(joined).toContain(`${index + 1}）${step}`);
      }
    }

    // ④ 答案以推送到达，且不再跟一条「过程记录」。
    expect(pushes.at(-1)).toContain(ANSWER);
    expect(joined).not.toContain("过程记录");
  });

  it("死窗后的收尾：答案正文随推送出门时不再押着「长任务处理中」的状态尾巴", async () => {
    // 现场：任务实际已经结束，聊天记录里最后一段正文却以
    // 「【长任务处理中，请勿打断，已用时12m24s】」收尾。窗口一死，答案正文只能以
    // block 到达推送车道，而推送车道给每条带新内容的推送都缀上时钟——正文是答案
    // 本身而不是过程；final 紧随其后只能再补一句「回复已完成」，那行状态就永远
    // 留在了答案的末尾。12m24s 这种非整分的读数正是「死亡时刻 + N×60s」网格的
    // 指纹，而不是 8m00s 起算的气泡网格。
    const sim = new WecomGatewaySim({ ackLatencyMs: 60, rejectAfterMs: 6 * 60_000 });
    const handle = startTurn(sim);
    await tick(100);

    await runTurn(handle, async ({ onItemEvent, deliverBlock, deliverFinal }) => {
      // 9 步 × 45 秒：第 9 步在 6m45s 撞上 846608，推送车道从这一刻接手。
      for (let i = 0; i < 9; i += 1) {
        await tick(45_000);
        await onItemEvent({
          itemId: `commentary-ending-${i + 1}`,
          kind: "preamble",
          progressText: `第 ${i + 1} 步：核对第 ${i + 1} 项配置`,
        });
      }
      // 模型静默工作到 12m30s，答案正文以 block 到达；下一格状态网格
      // （死亡时刻 + N×60s = 12m45s）落在 final 之前。
      await tick(5 * 60_000 + 45_000);
      await deliverBlock({ text: ANSWER });
      await tick(30_000);
      await deliverFinal({ text: ANSWER });
    });

    const pushes = pushContents(sim);
    const answerPushes = pushes.filter((push) => push.includes(ANSWER));
    // 答案恰好出现一次（不因去掉状态行而重复），且不带任何状态尾巴。
    expect(answerPushes).toHaveLength(1);
    expect(answerPushes[0]).not.toContain(LONG_TASK_STATUS_PREFIX);
    expect(answerPushes[0]).not.toContain("【处理中，已用时");
    // 收尾之后，聊天记录的最后一条不是一句状态；正文已全部送达时只剩一个
    // 收尾标记，不再是「最终回复已完成，以上预览内容即为完整回复。」。
    expect(pushes.at(-1)).not.toContain(LONG_TASK_STATUS_PREFIX);
    expect(pushes.at(-1)).toBe("（回复完毕）");
  });

  it("正文帧把日志挤出气泡后，这些步骤仍会随推送落到聊天记录", async () => {
    // 气泡是整帧覆盖：一帧正文预览（不含日志）会把刚显示过的步骤抹掉。若把
    // 「气泡展示过」直接当成已送达，流窗一死这些步骤就再也没人送了。
    const sim = new WecomGatewaySim({ ackLatencyMs: 60, rejectAfterMs: 6 * 60_000 });
    const handle = startTurn(sim);
    await tick(100);

    await runTurn(handle, async ({ onItemEvent, deliverBlock, deliverFinal }) => {
      await tick(30_000);
      await onItemEvent({
        itemId: "commentary-wiped-1",
        kind: "preamble",
        progressText: "先读取配置文件",
      });
      await tick(30_000);
      // 一帧纯正文预览覆盖整条气泡，日志从屏幕上消失。
      await deliverBlock({ text: "初步结论：配置存在冲突。" });
      // 流窗关闭后才有下一步自述：这一帧撞上 846608，推送通道接手。
      await tick(6 * 60_000);
      await onItemEvent({
        itemId: "commentary-wiped-2",
        kind: "preamble",
        progressText: "再核对运行记录",
      });
      await tick(90_000);
      await deliverFinal({ text: ANSWER });
    });

    const joined = pushContents(sim).join("\n===\n");
    // 被正文帧抹掉的那一步没有被当成「已送达」，它随推送补齐。
    expect(joined).toContain("先读取配置文件");
    expect(joined).toContain("再核对运行记录");
  });

  it("推送明确带上会话类型：单聊 1、群聊 2", async () => {
    // 企微文档：chat_type 不填时服务端「优先按群聊处理」再自动兼容。入站帧
    // 已经告诉了我们这是单聊还是群聊，没有理由让服务端去猜。
    const pushKindsFor = async (
      chatKind: "direct" | "group",
      reqId: string,
    ): Promise<Array<number | undefined>> => {
      __resetBotWsReplyTestState();
      const sim = new WecomGatewaySim({ ackLatencyMs: 60, rejectAfterMs: 6 * 60_000 });
      const handle = startTurn(sim, reqId, chatKind);
      await tick(100);
      await runTurn(handle, async ({ onItemEvent, deliverFinal }) => {
        for (let i = 0; i < 3; i += 1) {
          await tick(150_000);
          await onItemEvent({
            itemId: `commentary-chattype-${i + 1}`,
            kind: "preamble",
            progressText: `第 ${i + 1} 步：核对第 ${i + 1} 项配置`,
          });
        }
        await tick(90_000);
        await deliverFinal({ text: ANSWER });
      });
      return sim.chat
        .filter((entry) => entry.kind === "push")
        .map((entry) => (entry.kind === "push" ? entry.chatType : undefined));
    };

    const direct = await pushKindsFor("direct", "req-direct");
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.every((kind) => kind === 1)).toBe(true);

    const group = await pushKindsFor("group", "req-group");
    expect(group.length).toBeGreaterThan(0);
    expect(group.every((kind) => kind === 2)).toBe(true);
  });
});
