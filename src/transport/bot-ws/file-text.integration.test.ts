import { afterEach, describe, expect, it, vi } from "vitest";

const sdkState = vi.hoisted(() => {
  let streamCounter = 0;
  class MockWSClient {
    readonly handlers = new Map<string, Array<(frame: any) => void>>();
    readonly isConnected = true;
    readonly replyStream = vi.fn();
    readonly replyWelcome = vi.fn().mockResolvedValue({});
    readonly sendMessage = vi.fn();

    constructor() {
      sdkState.client = this;
    }

    on(event: string, handler: (frame: any) => void): void {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    emit(event: string, frame: any): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(frame);
      }
    }

    connect(): void {}
    disconnect(): void {}
  }

  return {
    client: null as InstanceType<typeof MockWSClient> | null,
    MockWSClient,
    nextStreamId: () => `stream-${++streamCounter}`,
  };
});

const handoffState = vi.hoisted(() => ({
  activeSessionId: undefined as string | undefined,
  resolveActiveEmbeddedRunSessionId: vi.fn(() => handoffState.activeSessionId),
  abortAgentHarnessRun: vi.fn((sessionId: string) => {
    if (handoffState.activeSessionId !== sessionId) {
      return false;
    }
    handoffState.activeSessionId = undefined;
    return true;
  }),
  abortAndDrainAgentHarnessRun: vi.fn(async ({ sessionId }: { sessionId: string }) => {
    if (handoffState.activeSessionId === sessionId) {
      handoffState.activeSessionId = undefined;
    }
    return { aborted: true, drained: true, forceCleared: false };
  }),
}));

vi.mock("@wecom/aibot-node-sdk", () => ({
  default: { WSClient: sdkState.MockWSClient },
  WSClient: sdkState.MockWSClient,
  generateReqId: () => sdkState.nextStreamId(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => handoffState);

import { dispatchInboundEvent } from "../../runtime/dispatcher.js";
import { WecomGatewaySim } from "../../test-utils/wecom-gateway-sim.js";
import type { ReplyHandle, UnifiedInboundEvent } from "../../types/index.js";
import { BotWsSdkAdapter } from "./sdk-adapter.js";
import { __resetBotWsReplyTestState } from "./reply.js";

type ScenarioParams = {
  id: string;
  order: "file-text" | "text-file";
  delayMs: number;
  sameReqId?: boolean;
  ackLatencyMs?: number;
  dropAckOnSend?: number[];
  firstVisible?: boolean;
};

type ScenarioResult = {
  sim: WecomGatewaySim;
  contexts: Array<{ body: string; mediaPath?: string }>;
  firstReqId: string;
  secondReqId: string;
};

const adapters: BotWsSdkAdapter[] = [];

function makeFrame(params: {
  kind: "file" | "text";
  reqId: string;
  msgId: string;
  userId: string;
}) {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: params.reqId },
    body: {
      msgid: params.msgId,
      msgtype: params.kind,
      chattype: "single",
      from: { userid: params.userId },
      ...(params.kind === "file"
        ? { file: { url: `https://example.com/${params.msgId}.pdf`, aeskey: "file-key" } }
        : { text: { content: "请把附件整理成表格" } }),
    },
  };
}

async function driveUntil(predicate: () => boolean, maxMs = 30_000): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs && !predicate(); elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50);
  }
  await Promise.resolve();
}

async function runScenario(params: ScenarioParams): Promise<ScenarioResult> {
  vi.useFakeTimers();
  const accountId = `file-text-${params.id}`;
  const userId = `user-${params.id}`;
  const sessionKey = `agent:test:wecom:${accountId}:dm:${userId}`;
  const contexts: ScenarioResult["contexts"] = [];
  const seen = new Set<string>();
  const store = {
    markInboundSeen: (event: UnifiedInboundEvent) => {
      if (seen.has(event.messageId)) {
        return false;
      }
      seen.add(event.messageId);
      return true;
    },
    writeReplyContext: vi.fn(),
    readReplyContext: vi.fn(),
    writeTransportSession: vi.fn(),
    readTransportSession: vi.fn(),
    writeDeliveryTask: vi.fn(),
    readDeliveryTask: vi.fn(),
  };
  let dispatchCount = 0;
  const dispatcher = vi.fn(async (dispatchParams: any) => {
    const runIndex = dispatchCount++;
    const runId = `${params.id}-run-${runIndex + 1}`;
    contexts.push({
      body: String(dispatchParams.ctx.Body ?? ""),
      mediaPath: dispatchParams.ctx.MediaPath,
    });
    handoffState.activeSessionId = runId;
    await dispatchParams.replyOptions?.onAgentRunStart?.();

    const waitsForSuccessor =
      runIndex === 0 &&
      (params.order === "text-file" ||
        (params.order === "file-text" && params.delayMs >= 1_000));
    if (waitsForSuccessor) {
      if (params.firstVisible) {
        await dispatchParams.dispatcherOptions.deliver(
          { text: "前驱回合已经可见" },
          { kind: "block" },
        );
      }
      const signal = dispatchParams.replyOptions?.abortSignal as AbortSignal | undefined;
      if (!signal?.aborted) {
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      if (handoffState.activeSessionId === runId) {
        handoffState.activeSessionId = undefined;
      }
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    }

    await dispatchParams.dispatcherOptions.deliver({ text: "第一段正文。" }, { kind: "block" });
    await dispatchParams.dispatcherOptions.deliver({ text: "第二段正文。" }, { kind: "block" });
    await dispatchParams.dispatcherOptions.deliver({ text: "第三段结论。" }, { kind: "final" });
    if (handoffState.activeSessionId === runId) {
      handoffState.activeSessionId = undefined;
    }
    return { queuedFinal: true, counts: { block: 2, final: 1, tool: 0 } };
  });

  const core = {
    channel: {
      routing: {
        resolveAgentRoute: () => ({ accountId, agentId: "test", sessionKey }),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: dispatcher,
        finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
      },
      session: {
        resolveStorePath: () => `/tmp/${accountId}-sessions.json`,
        readSessionUpdatedAt: () => Date.now() - 1_000,
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
  const mediaService = {
    normalizeFirstAttachment: vi.fn(async (event: UnifiedInboundEvent) =>
      event.attachments?.length
        ? {
            buffer: Buffer.from("fixture"),
            contentType: "application/pdf",
            filename: "fixture.pdf",
          }
        : undefined,
    ),
    saveInboundAttachment: vi.fn(async () => `/tmp/${params.id}.pdf`),
  };
  const auditLog = { appendOperational: vi.fn(), appendInbound: vi.fn() };
  const runtime = {
    account: {
      accountId,
      bot: {
        accountId,
        wsConfigured: true,
        ws: { botId: `bot-${params.id}`, secret: "secret" },
        config: {},
      },
    },
    handleEvent: (event: UnifiedInboundEvent, replyHandle: ReplyHandle) =>
      dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: store as any,
        auditLog: auditLog as any,
        mediaService: mediaService as any,
        event,
        replyHandle,
      }),
    updateTransportSession: vi.fn(),
    touchTransportSession: vi.fn(),
    recordOperationalIssue: vi.fn(),
  };

  const adapter = new BotWsSdkAdapter(runtime as any, {} as any);
  adapters.push(adapter);
  adapter.start();
  const client = sdkState.client!;
  const sim = new WecomGatewaySim({
    ackLatencyMs: params.ackLatencyMs ?? 60,
    dropAckOnSend: params.dropAckOnSend,
  });
  client.replyStream.mockImplementation(sim.replyStream.bind(sim));
  (client as any).replyStreamNonBlocking = vi.fn(sim.replyStreamNonBlocking.bind(sim));
  (client as any).hasPendingReplyAck = vi.fn(sim.hasPendingReplyAck.bind(sim));
  client.sendMessage.mockImplementation(sim.sendMessage.bind(sim));

  const firstReqId = `req-${params.id}-shared`;
  const secondReqId = params.sameReqId ? firstReqId : `req-${params.id}-second`;
  const firstKind = params.order === "file-text" ? "file" : "text";
  const secondKind = params.order === "file-text" ? "text" : "file";
  client.emit(
    "message",
    makeFrame({ kind: firstKind, reqId: firstReqId, msgId: `msg-${params.id}-first`, userId }),
  );
  await vi.advanceTimersByTimeAsync(params.delayMs);
  client.emit(
    "message",
    makeFrame({
      kind: secondKind,
      reqId: secondReqId,
      msgId: `msg-${params.id}-second`,
      userId,
    }),
  );

  await driveUntil(() => {
    const visible = sim.visibleText().join("\n");
    return visible.includes("第三段结论。") && handoffState.activeSessionId === undefined;
  });
  await vi.advanceTimersByTimeAsync(20_000);
  return { sim, contexts, firstReqId, secondReqId };
}

afterEach(() => {
  for (const adapter of adapters.splice(0)) {
    adapter.stop();
  }
  __resetBotWsReplyTestState();
  handoffState.activeSessionId = undefined;
  handoffState.resolveActiveEmbeddedRunSessionId.mockClear();
  handoffState.abortAgentHarnessRun.mockClear();
  handoffState.abortAndDrainAgentHarnessRun.mockClear();
  sdkState.client = null;
  vi.useRealTimers();
});

describe("file and text Bot WS integration", () => {
  it("keeps one cumulative bubble for file then text inside the merge window", async () => {
    const result = await runScenario({
      id: "merged",
      order: "file-text",
      delayMs: 100,
      ackLatencyMs: 1_500,
    });

    expect(result.contexts).toEqual([
      { body: "请把附件整理成表格", mediaPath: "/tmp/merged.pdf" },
    ]);
    const bubble = result.sim.streamBubble(result.firstReqId);
    expect(bubble?.content).toContain("第一段正文。");
    expect(bubble?.content).toContain("第二段正文。");
    expect(bubble?.content).toContain("第三段结论。");
    expect(result.sim.streamBubble(result.secondReqId)).toBeUndefined();
  });

  it("does not revive a lost-ACK file placeholder after its turn is superseded", async () => {
    const result = await runScenario({
      id: "lost-placeholder",
      order: "file-text",
      delayMs: 1_001,
      ackLatencyMs: 60,
      dropAckOnSend: [1],
    });

    expect(result.contexts).toHaveLength(2);
    expect(result.contexts[1]).toMatchObject({
      body:
        "[file] https://example.com/msg-lost-placeholder-first.pdf\n请把附件整理成表格",
      mediaPath: "/tmp/lost-placeholder.pdf",
    });
    expect(result.sim.visibleText().join("\n")).toContain("第三段结论。");
    expect(result.sim.streamBubble(result.firstReqId)).toBeUndefined();
  });

  it("keeps adjacent visible turns in separate bubbles when req_id values are unique", async () => {
    const result = await runScenario({
      id: "unique-req",
      order: "text-file",
      delayMs: 100,
      firstVisible: true,
    });

    expect(result.sim.streamBubble(result.firstReqId)?.content).toContain("前驱回合已经可见");
    expect(result.sim.streamBubble(result.secondReqId)?.content).toContain("第三段结论。");
  });

  it("keeps both visible turns when adjacent callbacks reuse one req_id", async () => {
    const result = await runScenario({
      id: "same-req",
      order: "text-file",
      delayMs: 100,
      sameReqId: true,
      firstVisible: true,
    });

    const sourceBubble = result.sim.streamBubble(result.firstReqId);
    expect(sourceBubble?.content).toContain("前驱回合已经可见");
    expect(result.sim.chat.some((entry) => entry.kind === "push" && entry.content.includes("第三段结论。"))).toBe(true);
  });

  it("keeps both visible turns when a reused req_id meets a late ACK", async () => {
    const result = await runScenario({
      id: "same-req-late-ack",
      order: "text-file",
      delayMs: 6_100,
      sameReqId: true,
      ackLatencyMs: 6_000,
      firstVisible: true,
    });

    const visibleText = result.sim.visibleText().join("\n");
    expect(visibleText).toContain("前驱回合已经可见");
    expect(visibleText).toContain("第三段结论。");
  });
});
