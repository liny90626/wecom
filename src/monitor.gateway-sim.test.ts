/**
 * Drives the Bot WS lane end to end (monitorWeComProvider → deliver →
 * finishThinkingStream) against an in-memory WeCom gateway, so the frames and
 * pushes a user would actually receive can be asserted. The gateway models the
 * facts that matter for delivery:
 * - a stream frame carries the WHOLE bubble; `finish: true` closes it;
 * - the documented `stream.content` ceiling is 20480 bytes;
 * - the gateway refuses a stale stream with errcode 846605 / 846608;
 * - a lost ACK surfaces as the SDK's "Reply ack timeout" rejection.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type SimFrame = { streamId: string; content: string; finish: boolean };

const hoisted = vi.hoisted(() => ({
  clients: [] as Array<{
    frames: SimFrame[];
    pushes: Array<{ chatid: string; content: string }>;
    mediaSends: Array<{ chatid: string; type: string; mediaId: string }>;
    replyStreamHook?: (frame: SimFrame) => Promise<unknown> | undefined;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
  core: undefined as unknown,
  seq: 0,
}));

vi.mock("@wecom/aibot-node-sdk", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWsClient extends EventEmitter {
    frames: SimFrame[] = [];
    pushes: Array<{ chatid: string; content: string }> = [];
    mediaSends: Array<{ chatid: string; type: string; mediaId: string }> = [];
    uploads: Array<{ bytes: number; type: string; filename: string }> = [];
    replyStreamHook?: (frame: SimFrame) => Promise<unknown> | undefined;
    connected = false;

    constructor(_options: unknown) {
      super();
      hoisted.clients.push(this as never);
    }

    connect() {
      setTimeout(() => {
        this.connected = true;
        this.emit("connected");
        this.emit("authenticated");
      }, 0);
      return this;
    }

    disconnect() {
      this.connected = false;
    }

    get isConnected() {
      return this.connected;
    }

    async replyStream(_frame: unknown, streamId: string, content: string, finish = false) {
      const frame = { streamId, content, finish };
      this.frames.push(frame);
      const hooked = this.replyStreamHook?.(frame);
      if (hooked) {
        return await hooked;
      }
      return { errcode: 0 };
    }

    replyStreamNonBlocking(frame: unknown, streamId: string, content: string, finish = false) {
      return this.replyStream(frame, streamId, content, finish);
    }

    hasPendingReplyAck() {
      return false;
    }

    async sendMessage(chatid: string, body: { markdown?: { content?: string } }) {
      this.pushes.push({ chatid, content: body.markdown?.content ?? JSON.stringify(body) });
      return { headers: { req_id: `push-${this.pushes.length}` } };
    }

    async uploadMedia(buffer: Buffer, options: { type: string; filename: string }) {
      this.uploads.push({ bytes: buffer.length, ...options });
      return { media_id: `media-${this.uploads.length}` };
    }

    async sendMediaMessage(chatid: string, type: string, mediaId: string) {
      this.mediaSends.push({ chatid, type, mediaId });
      return { headers: { req_id: `media-${this.mediaSends.length}` } };
    }

    async reply() {
      return {};
    }

    async downloadFile() {
      throw new Error("not used by these scenarios");
    }
  }
  return {
    WSClient: FakeWsClient,
    generateReqId: (prefix: string) => `${prefix}-${++hoisted.seq}`,
    WSAuthFailureError: class WSAuthFailureError extends Error {},
    WSReconnectExhaustedError: class WSReconnectExhaustedError extends Error {},
  };
});

vi.mock("./runtime.js", () => ({
  getWeComRuntime: () => hoisted.core,
  setWeComRuntime: () => {},
}));

import { monitorWeComProvider } from "./monitor.js";

/** Official ceiling for one stream frame's content. */
const WECOM_STREAM_CONTENT_MAX_BYTES = 20_480;

type Step = { kind: "block" | "final"; payload: Record<string, unknown> };

function splitCodePoints(text: string, limit: number): string[] {
  const out: string[] = [];
  const points = Array.from(text);
  for (let index = 0; index < points.length; index += limit) {
    out.push(points.slice(index, index + limit).join(""));
  }
  return out;
}

function buildCore(script: Step[]) {
  return {
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: "main",
          sessionKey: "agent:main:wecom:default:direct:alice",
          mainSessionKey: "agent:main:main",
          matchedBy: "default",
          accountId: "default",
        }),
      },
      session: {
        resolveStorePath: () => path.join(os.tmpdir(), "wecom-gateway-sim-store"),
        recordInboundSession: async () => {},
      },
      text: {
        chunkMarkdownText: (text: string, limit: number) => splitCodePoints(text, limit),
      },
      reply: {
        finalizeInboundContext: (ctx: unknown) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: async (params: {
          dispatcherOptions: {
            onReplyStart?: () => Promise<void>;
            deliver: (payload: unknown, info: { kind: string }) => Promise<void>;
            onError?: (err: unknown, info: { kind: string }) => void;
          };
        }) => {
          await params.dispatcherOptions.onReplyStart?.();
          for (const step of script) {
            try {
              await params.dispatcherOptions.deliver(step.payload, { kind: step.kind });
            } catch (err) {
              // The real dispatcher counts the failure, reports it and keeps the chain going.
              params.dispatcherOptions.onError?.(err, { kind: step.kind });
            }
          }
        },
      },
    },
  };
}

async function runTurn(params: {
  script: Step[];
  replyStreamHook?: (frame: SimFrame) => Promise<unknown> | undefined;
  mediaLocalRoots?: string[];
}) {
  hoisted.core = buildCore(params.script);
  const logs: string[] = [];
  let settle!: () => void;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const observe = (msg: string) => {
    logs.push(msg);
    if (msg.includes("stage=message_complete") || msg.includes("stage=finish_after_failure_failed")) {
      settle();
    } else if (msg.includes("stage=message_failed")) {
      // The failure path retries the finish once more before cleaning up.
      setTimeout(settle, 500);
    }
  };
  const runtime = { log: observe, error: observe, exit: () => {} };
  const abort = new AbortController();
  const account = {
    accountId: "default",
    name: "sim",
    enabled: true,
    websocketUrl: "wss://sim.invalid",
    botId: "bot",
    secret: "secret",
    sendThinkingMessage: true,
    config: { dmPolicy: "open", ...(params.mediaLocalRoots ? { mediaLocalRoots: params.mediaLocalRoots } : {}) },
  };
  const config = { channels: { wecom: { botId: "bot", secret: "secret" } } };
  const monitor = monitorWeComProvider({
    account: account as never,
    config: config as never,
    runtime: runtime as never,
    abortSignal: abort.signal,
  });
  const client = hoisted.clients.at(-1)!;
  client.replyStreamHook = params.replyStreamHook;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const id = ++hoisted.seq;
  client.emit("message", {
    cmd: "aibot_callback",
    headers: { req_id: `req-${id}` },
    body: {
      msgid: `msg-${id}`,
      chattype: "single",
      from: { userid: "alice" },
      msgtype: "text",
      text: { content: "开始" },
    },
  });
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`turn did not settle; logs:\n${logs.join("\n")}`)), 25_000),
  );
  await Promise.race([finished, deadline]);
  abort.abort();
  await monitor;
  return { client, logs };
}

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
const ackTimeout = () =>
  Promise.reject(new Error("Reply ack timeout (5000ms) for reqId: req-sim"));
const gatewayRefusal = (errcode: number, errmsg: string) =>
  Promise.reject(Object.assign(new Error(errmsg), { errcode, errmsg }));

describe("Bot WS lane against the gateway simulator", () => {
  afterEach(() => {
    hoisted.clients.length = 0;
  });

  it("keeps every stream frame within the documented content ceiling and pushes the rest", async () => {
    // 4 blocks × 4000 CJK chars = 48 000 bytes, 2.3× the 20 480-byte ceiling.
    const blocks = Array.from({ length: 4 }, (_, index) => `第${index + 1}段：${"中文内容".repeat(999)}\n\n`);
    const answer = blocks.join("");
    const { client } = await runTurn({
      script: [
        ...blocks.map((text) => ({ kind: "block" as const, payload: { text } })),
        { kind: "final", payload: { text: "" } },
      ],
    });

    const oversized = client.frames.filter((frame) => utf8Bytes(frame.content) > WECOM_STREAM_CONTENT_MAX_BYTES);
    expect(oversized, "frames over the gateway ceiling").toEqual([]);
    const finish = client.frames.filter((frame) => frame.finish);
    expect(finish).toHaveLength(1);
    // The bubble holds the head; the remainder arrives as ordered pushes, nothing lost.
    const delivered = finish[0]!.content + client.pushes.map((push) => push.content).join("");
    expect(delivered.replace(/\s+/g, "")).toBe(answer.replace(/\s+/g, ""));
    expect(client.pushes.length).toBeGreaterThan(0);
  }, 30_000);

  it("streams a short answer into one bubble without any push", async () => {
    const { client } = await runTurn({
      script: [
        { kind: "block", payload: { text: "第一段。" } },
        { kind: "block", payload: { text: "第二段。" } },
        { kind: "final", payload: { text: "" } },
      ],
    });

    const finish = client.frames.filter((frame) => frame.finish);
    expect(finish).toHaveLength(1);
    expect(finish[0]!.content).toBe("第一段。第二段。");
    expect(client.pushes).toEqual([]);
  });

  it("falls back to an active push when the finish frame loses its ACK", async () => {
    const { client } = await runTurn({
      script: [
        { kind: "block", payload: { text: "答案正文。" } },
        { kind: "final", payload: { text: "" } },
      ],
      replyStreamHook: (frame) => (frame.finish ? ackTimeout() : undefined),
    });

    expect(client.pushes.map((push) => push.content)).toContain("答案正文。");
  });

  it("treats 846605 (invalid req_id) like an expired window and pushes the answer", async () => {
    const { client } = await runTurn({
      script: [
        { kind: "block", payload: { text: "答案正文。" } },
        { kind: "final", payload: { text: "" } },
      ],
      replyStreamHook: (frame) => (frame.finish ? gatewayRefusal(846605, "invalid req_id") : undefined),
    });

    expect(client.pushes.map((push) => push.content)).toContain("答案正文。");
  });

  it("pushes a long answer in gateway-sized chunks once the window has expired", async () => {
    const answer = `${"长文".repeat(6000)}`; // 36 000 bytes
    let frames = 0;
    const { client } = await runTurn({
      script: [
        { kind: "block", payload: { text: answer.slice(0, 6000) } },
        { kind: "block", payload: { text: answer.slice(6000) } },
        { kind: "final", payload: { text: "" } },
      ],
      replyStreamHook: () => {
        frames += 1;
        // The thinking frame lands; the window is gone by the time the body arrives.
        return frames > 1 ? gatewayRefusal(846608, "stream message update expired") : undefined;
      },
    });

    expect(client.pushes.length).toBeGreaterThan(1);
    expect(client.pushes.every((push) => utf8Bytes(push.content) <= WECOM_STREAM_CONTENT_MAX_BYTES)).toBe(true);
    expect(client.pushes.map((push) => push.content).join("")).toBe(answer);
  }, 30_000);

  it("sends the attachment before closing the bubble with the text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wecom-sim-media-"));
    const filePath = path.join(root, "report.txt");
    await writeFile(filePath, "report body");
    const { client } = await runTurn({
      script: [{ kind: "final", payload: { text: "报告已生成。", mediaUrls: [filePath] } }],
      mediaLocalRoots: [root],
    });

    expect(client.mediaSends).toHaveLength(1);
    const finish = client.frames.filter((frame) => frame.finish);
    expect(finish).toHaveLength(1);
    expect(finish[0]!.content).toBe("报告已生成。");
  });
});
