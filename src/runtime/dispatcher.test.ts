import { describe, expect, it, vi } from "vitest";

import { dispatchInboundEvent } from "./dispatcher.js";
import type { ReplyHandle, UnifiedInboundEvent } from "../types/index.js";

function makeEvent(messageId: string, text: string): UnifiedInboundEvent {
  return {
    accountId: "acct",
    capability: "bot",
    transport: "bot-ws",
    inboundKind: "text",
    messageId,
    conversation: {
      accountId: "acct",
      peerKind: "direct",
      peerId: "alice",
      senderId: "alice",
    },
    text,
    timestamp: Date.now(),
    raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
    replyContext: {
      transport: "bot-ws",
      accountId: "acct",
      raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
    },
  };
}

function makeReplyHandle(supersedeByNewInbound = vi.fn()): ReplyHandle {
  return {
    context: {
      transport: "bot-ws",
      accountId: "acct",
      raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
    },
    deliver: vi.fn(),
    supersedeByNewInbound,
  };
}

function makeCore(dispatchReplyWithBufferedBlockDispatcher: ReturnType<typeof vi.fn>) {
  return {
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          accountId: "acct",
          agentId: "ops_bot",
          sessionKey: "agent:ops_bot:wecom:acct:dm:alice",
        }),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
        finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
      },
      session: {
        resolveStorePath: () => "/tmp/wecom-dispatcher-test",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
}

function makeStore() {
  const seen = new Set<string>();
  return {
    markInboundSeen: (event: UnifiedInboundEvent) => {
      if (seen.has(event.messageId)) return false;
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
}

describe("dispatchInboundEvent", () => {
  it("aborts the superseded same-peer dispatch and still dispatches the newer message to OpenClaw", async () => {
    let firstAbortSignal: AbortSignal | undefined;
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementationOnce(
        (params) => {
          firstAbortSignal = params.replyOptions?.abortSignal;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => resolve({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } }),
              10_000,
            );
            firstAbortSignal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(firstAbortSignal?.reason ?? new Error("aborted"));
              },
              { once: true },
            );
          });
        },
      )
      .mockResolvedValueOnce({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
    const store = makeStore();
    const auditLog = { appendOperational: vi.fn(), appendInbound: vi.fn() };
    const mediaService = {
      normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
      saveInboundAttachment: vi.fn(),
    };
    const oldSupersede = vi.fn();

    const first = dispatchInboundEvent({
      core: core as any,
      cfg: {} as any,
      store: store as any,
      auditLog: auditLog as any,
      mediaService: mediaService as any,
      event: makeEvent("msg-a", "A"),
      replyHandle: makeReplyHandle(oldSupersede),
    });
    await Promise.resolve();
    await Promise.resolve();

    await dispatchInboundEvent({
      core: core as any,
      cfg: {} as any,
      store: store as any,
      auditLog: auditLog as any,
      mediaService: mediaService as any,
      event: makeEvent("msg-b", "B"),
      replyHandle: makeReplyHandle(),
    });

    await first;

    expect(oldSupersede).toHaveBeenCalledWith({
      accountId: "acct",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    expect(firstAbortSignal?.aborted).toBe(true);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
  });
});
