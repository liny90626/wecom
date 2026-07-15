import { describe, expect, it, vi } from "vitest";

const openClawHandoffState = vi.hoisted(() => ({
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  abortAndDrainAgentHarnessRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => openClawHandoffState);

import { dispatchInboundEvent } from "./dispatcher.js";
import type { ReplyHandle, UnifiedInboundEvent } from "../types/index.js";
import {
  registerActiveBotWsReplyHandle,
  unregisterActiveBotWsReplyHandle,
} from "../runtime.js";

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

function makeReplyHandle(
  supersedeByNewInbound = vi.fn(),
  overrides: Partial<ReplyHandle> = {},
): ReplyHandle {
  return {
    context: {
      transport: "bot-ws",
      accountId: "acct",
      raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
    },
    deliver: vi.fn(),
    supersedeByNewInbound,
    ...overrides,
  };
}

function makeCore(
  dispatchReplyWithBufferedBlockDispatcher: ReturnType<typeof vi.fn>,
  recordInboundSession = vi.fn().mockResolvedValue(undefined),
) {
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
        recordInboundSession,
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
  it("dispatches the same inbound message id to OpenClaw only once", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
    const store = makeStore();
    const auditLog = { appendOperational: vi.fn(), appendInbound: vi.fn() };
    const mediaService = {
      normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
      saveInboundAttachment: vi.fn(),
    };
    const duplicateActivate = vi.fn();
    const event = makeEvent("msg-duplicate", "只发送一次");

    await dispatchInboundEvent({
      core: core as any,
      cfg: {} as any,
      store: store as any,
      auditLog: auditLog as any,
      mediaService: mediaService as any,
      event,
      replyHandle: makeReplyHandle(),
    });
    await dispatchInboundEvent({
      core: core as any,
      cfg: {} as any,
      store: store as any,
      auditLog: auditLog as any,
      mediaService: mediaService as any,
      event,
      replyHandle: makeReplyHandle(undefined, { activate: duplicateActivate }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(duplicateActivate).not.toHaveBeenCalled();
    expect(auditLog.appendOperational).toHaveBeenCalledWith(
      expect.objectContaining({ category: "duplicate-inbound", messageId: "msg-duplicate" }),
    );
  });

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
    await vi.waitFor(() =>
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1),
    );

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

  it("waits for cold session metadata before the first core dispatch", async () => {
    let releaseMetadata!: () => void;
    const metadataTask = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    const recordInboundSession = vi.fn(async (params) => {
      params.trackSessionMetaTask?.(metadataTask);
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher, recordInboundSession);
    const operation = dispatchInboundEvent({
      core: core as any,
      cfg: {} as any,
      store: makeStore() as any,
      auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
      mediaService: {
        normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
        saveInboundAttachment: vi.fn(),
      } as any,
      event: makeEvent("msg-cold-metadata", "cold"),
      replyHandle: makeReplyHandle(),
    });

    await vi.waitFor(() => expect(recordInboundSession).toHaveBeenCalledTimes(1));
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    releaseMetadata();
    await operation;
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("supersedes the previous handle before a stuck prepare can reach core", async () => {
    vi.useFakeTimers();
    try {
      let releaseFirstPrepare!: () => void;
      const firstAttachment = new Promise<undefined>((resolve) => {
        releaseFirstPrepare = () => resolve(undefined);
      });
      const recordInboundSession = vi.fn().mockResolvedValue(undefined);
      const dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockResolvedValue({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
      const core = makeCore(dispatchReplyWithBufferedBlockDispatcher, recordInboundSession);
      const store = makeStore();
      const auditLog = { appendOperational: vi.fn(), appendInbound: vi.fn() };
      const oldSupersede = vi.fn();
      const oldFail = vi.fn();

      const first = dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: store as any,
        auditLog: auditLog as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn(() => firstAttachment),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-stuck-prepare-a", "A"),
        replyHandle: makeReplyHandle(oldSupersede, { fail: oldFail }),
      });
      await Promise.resolve();

      const second = dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: store as any,
        auditLog: auditLog as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-stuck-prepare-b", "B"),
        replyHandle: makeReplyHandle(),
      });

      await first;
      expect(oldSupersede).toHaveBeenCalledTimes(1);
      expect(oldFail).not.toHaveBeenCalled();
      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await second;
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      expect(recordInboundSession).toHaveBeenCalledTimes(1);

      releaseFirstPrepare();
      await Promise.resolve();
      await Promise.resolve();
      expect(recordInboundSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delay a newer dispatch when OpenClaw accepts the handoff", async () => {
    vi.useFakeTimers();
    try {
      let releaseFirstCore!: () => void;
      const firstCore = new Promise<{ queuedFinal: true; counts: { block: 0; final: 1; tool: 0 } }>(
        (resolve) => {
          releaseFirstCore = () =>
            resolve({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
        },
      );
      const dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementationOnce(() => firstCore)
        .mockResolvedValueOnce({
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        });
      const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
      const store = makeStore();
      const auditLog = { appendOperational: vi.fn(), appendInbound: vi.fn() };
      const mediaService = {
        normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
        saveInboundAttachment: vi.fn(),
      };

      const first = dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: store as any,
        auditLog: auditLog as any,
        mediaService: mediaService as any,
        event: makeEvent("msg-core-a", "A"),
        replyHandle: makeReplyHandle(),
      });
      await vi.waitFor(() =>
        expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1),
      );

      const second = dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: store as any,
        auditLog: auditLog as any,
        mediaService: mediaService as any,
        event: makeEvent("msg-core-b", "B"),
        replyHandle: makeReplyHandle(),
      });
      await first;

      await second;
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);

      releaseFirstCore();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a transient init conflict while a superseded long task settles", async () => {
    vi.useFakeTimers();
    let releaseFirstCore: (() => void) | undefined;
    try {
      const firstCore = new Promise<{ queuedFinal: true; counts: { block: 0; final: 1; tool: 0 } }>(
        (resolve) => {
          releaseFirstCore = () =>
            resolve({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
        },
      );
      const conflict = new Error(
        "reply session initialization conflicted for agent:ops_bot:wecom:acct:dm:alice",
      );
      const wrappedConflict = new Error("OpenClaw dispatch failed", { cause: conflict });
      const dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementationOnce(() => firstCore)
        .mockRejectedValueOnce(wrappedConflict)
        .mockImplementationOnce(async (params) => {
          await params.dispatcherOptions.deliver({ text: "new task completed" }, { kind: "final" });
          return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
        });
      const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
      const store = makeStore();
      const auditLog = { appendOperational: vi.fn(), appendInbound: vi.fn() };
      const mediaService = {
        normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
        saveInboundAttachment: vi.fn(),
      };
      const first = dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: store as any,
        auditLog: auditLog as any,
        mediaService: mediaService as any,
        event: makeEvent("msg-conflict-a", "long task"),
        replyHandle: makeReplyHandle(),
      });
      await vi.waitFor(() =>
        expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1),
      );

      const deliver = vi.fn().mockResolvedValue(undefined);
      const fail = vi.fn().mockResolvedValue(undefined);
      const second = dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: store as any,
        auditLog: auditLog as any,
        mediaService: mediaService as any,
        event: makeEvent("msg-conflict-b", "new message"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver, fail }),
      });
      const secondOutcome = second.then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );
      await first;
      setTimeout(() => releaseFirstCore?.(), 400);

      await vi.advanceTimersByTimeAsync(499);
      expect(fail).not.toHaveBeenCalled();
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      await expect(secondOutcome).resolves.toEqual({ ok: true });
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(3);
      expect(deliver).toHaveBeenCalledWith(
        { text: "new task completed" },
        { kind: "final" },
      );
    } finally {
      releaseFirstCore?.();
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it("drains a superseded OpenClaw run before admitting the next message", async () => {
    let releaseFirstRun: (() => void) | undefined;
    let firstRunBusy = false;
    let dispatchCount = 0;
    const fallbackReleaseTimer = setTimeout(() => releaseFirstRun?.(), 1_000);
    const result = { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } } as const;
    const conflict = new Error(
      "reply session initialization conflicted for agent:ops_bot:wecom:acct:dm:alice",
    );

    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-a");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockImplementation(async () => {
      releaseFirstRun?.();
      return { aborted: true, drained: true, forceCleared: false };
    });

    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation((params) => {
      dispatchCount += 1;
      if (firstRunBusy) {
        return Promise.reject(conflict);
      }
      if (dispatchCount > 1) {
        return params.dispatcherOptions
          .deliver({ text: "follow-up" }, { kind: "final" })
          .then(() => result);
      }
      firstRunBusy = true;
      return new Promise((resolve, reject) => {
        releaseFirstRun = () => {
          firstRunBusy = false;
          resolve(result);
        };
        params.replyOptions?.abortSignal?.addEventListener(
          "abort",
          () => reject(params.replyOptions.abortSignal.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
    const common = {
      core: core as any,
      cfg: {} as any,
      store: makeStore() as any,
      auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
      mediaService: {
        normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
        saveInboundAttachment: vi.fn(),
      } as any,
    };

    try {
      const first = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-drain-a", "long task"),
        replyHandle: makeReplyHandle(),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

      const deliver = vi.fn().mockResolvedValue(undefined);
      const fail = vi.fn().mockResolvedValue(undefined);
      const second = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-drain-b", "follow-up"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver, fail }),
      });
      const secondOutcome = second.then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );

      await first;
      await expect(secondOutcome).resolves.toEqual({ ok: true });
      expect(openClawHandoffState.abortAndDrainAgentHarnessRun).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "run-a", sessionKey: expect.any(String) }),
      );
      expect(deliver).toHaveBeenCalledWith({ text: "follow-up" }, { kind: "final" });
      expect(fail).not.toHaveBeenCalled();
    } finally {
      clearTimeout(fallbackReleaseTimer);
      releaseFirstRun?.();
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
    }
  });

  it("chains the drain barrier when a third message supersedes a waiting handoff", async () => {
    let releaseDrain!: () => void;
    let drainReleased = false;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = () => {
        drainReleased = true;
        resolve();
      };
    });
    const result = { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } } as const;
    const conflict = new Error(
      "reply session initialization conflicted for agent:ops_bot:wecom:acct:dm:alice",
    );
    let dispatchCount = 0;

    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-a");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockImplementation(async () => {
      await drain;
      return { aborted: true, drained: true, forceCleared: false };
    });

    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation((params) => {
      dispatchCount += 1;
      if (dispatchCount === 1) {
        return new Promise((_resolve, reject) => {
          params.replyOptions?.abortSignal?.addEventListener(
            "abort",
            () => reject(params.replyOptions.abortSignal.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      }
      if (!drainReleased) {
        return Promise.reject(conflict);
      }
      return params.dispatcherOptions
        .deliver({ text: "latest task completed" }, { kind: "final" })
        .then(() => result);
    });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
    const common = {
      core: core as any,
      cfg: {} as any,
      store: makeStore() as any,
      auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
      mediaService: {
        normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
        saveInboundAttachment: vi.fn(),
      } as any,
    };

    try {
      const first = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-chain-a", "long task"),
        replyHandle: makeReplyHandle(),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

      const second = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-chain-b", "first follow-up"),
        replyHandle: makeReplyHandle(),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(openClawHandoffState.abortAndDrainAgentHarnessRun).toHaveBeenCalledTimes(1);

      const latestDeliver = vi.fn().mockResolvedValue(undefined);
      const latest = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-chain-c", "latest follow-up"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver: latestDeliver }),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

      releaseDrain();
      await Promise.allSettled([first, second, latest]);
      expect(latestDeliver).toHaveBeenCalledWith(
        { text: "latest task completed" },
        { kind: "final" },
      );
    } finally {
      releaseDrain();
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
    }
  });

  it("retries a persistent handoff conflict once and reports it once", async () => {
    vi.useFakeTimers();
    let releaseFirstCore: (() => void) | undefined;
    try {
      const firstCore = new Promise<{ queuedFinal: true; counts: { block: 0; final: 1; tool: 0 } }>(
        (resolve) => {
          releaseFirstCore = () =>
            resolve({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
        },
      );
      const conflict = new Error(
        "reply session initialization conflicted for agent:ops_bot:wecom:acct:dm:alice",
      );
      const dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementationOnce(() => firstCore)
        .mockRejectedValueOnce(conflict)
        .mockRejectedValueOnce(conflict);
      const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
      const store = makeStore();
      const common = {
        core: core as any,
        cfg: {} as any,
        store: store as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
          saveInboundAttachment: vi.fn(),
        } as any,
      };
      const first = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-persistent-a", "long task"),
        replyHandle: makeReplyHandle(),
      });
      await vi.waitFor(() =>
        expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1),
      );

      const fail = vi.fn().mockResolvedValue(undefined);
      const second = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-persistent-b", "new message"),
        replyHandle: makeReplyHandle(vi.fn(), { fail }),
      });
      const secondOutcome = second.then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      expect(fail).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await expect(secondOutcome).resolves.toEqual({ ok: false, error: conflict });
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(3);
      expect(fail).toHaveBeenCalledOnce();
      expect(fail).toHaveBeenCalledWith(conflict);
    } finally {
      releaseFirstCore?.();
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it("cancels a pending conflict retry when an even newer message takes over", async () => {
    vi.useFakeTimers();
    let releaseFirstCore: (() => void) | undefined;
    try {
      const firstCore = new Promise<{ queuedFinal: true; counts: { block: 0; final: 1; tool: 0 } }>(
        (resolve) => {
          releaseFirstCore = () =>
            resolve({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
        },
      );
      const conflict = new Error(
        "reply session initialization conflicted for agent:ops_bot:wecom:acct:dm:alice",
      );
      const dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementationOnce(() => firstCore)
        .mockRejectedValueOnce(conflict)
        .mockImplementationOnce(async (params) => {
          await params.dispatcherOptions.deliver({ text: "latest task completed" }, { kind: "final" });
          return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
        });
      const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
      const store = makeStore();
      const common = {
        core: core as any,
        cfg: {} as any,
        store: store as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
          saveInboundAttachment: vi.fn(),
        } as any,
      };
      const first = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-burst-a", "long task"),
        replyHandle: makeReplyHandle(),
      });
      await vi.waitFor(() =>
        expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1),
      );

      const secondDeliver = vi.fn().mockResolvedValue(undefined);
      const secondFail = vi.fn().mockResolvedValue(undefined);
      const second = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-burst-b", "first follow-up"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver: secondDeliver, fail: secondFail }),
      });
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);

      const latestDeliver = vi.fn().mockResolvedValue(undefined);
      const latestFail = vi.fn().mockResolvedValue(undefined);
      const latest = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-burst-c", "latest follow-up"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver: latestDeliver, fail: latestFail }),
      });

      await Promise.all([second, latest]);
      await vi.advanceTimersByTimeAsync(500);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(3);
      expect(secondDeliver).not.toHaveBeenCalled();
      expect(secondFail).not.toHaveBeenCalled();
      expect(latestFail).not.toHaveBeenCalled();
      expect(latestDeliver).toHaveBeenCalledWith(
        { text: "latest task completed" },
        { kind: "final" },
      );
    } finally {
      releaseFirstCore?.();
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it("recovers a stale OpenClaw run even when no prior WS handle is registered", async () => {
    const conflict = new Error(
      "reply session initialization conflicted for agent:ops_bot:wecom:acct:dm:alice",
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "早上消息已恢复" }, { kind: "final" });
        return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
      });
    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockResolvedValue({
      aborted: true,
      drained: true,
      forceCleared: false,
    });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
    core.channel.reply.finalizeInboundContext = (ctx: Record<string, unknown>) => ({
      ...ctx,
      SessionId: "stale-reply-run",
    });

    try {
      await dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: makeStore() as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-stale-run", "昨晚任务后的新消息"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver }),
      });
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      expect(openClawHandoffState.abortAndDrainAgentHarnessRun).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "stale-reply-run" }),
      );
      expect(deliver).toHaveBeenCalledWith({ text: "早上消息已恢复" }, { kind: "final" });
    } finally {
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
    }
  });

  it("does not remain blocked behind a stale handoff barrier", async () => {
    vi.useFakeTimers();
    const staleHandle = makeReplyHandle({
      waitForSupersede: () => new Promise<void>(() => undefined),
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: true,
      counts: { block: 0, final: 1, tool: 0 },
    });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
    const registration = {
      accountId: "acct",
      peerKind: "direct" as const,
      peerId: "alice",
      sessionKey: "stale-session",
      handle: staleHandle,
    };
    registerActiveBotWsReplyHandle(registration);

    try {
      const operation = dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: makeStore() as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-stale-barrier", "new message"),
        replyHandle: makeReplyHandle(),
      });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await operation;
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    } finally {
      unregisterActiveBotWsReplyHandle(registration);
      vi.useRealTimers();
    }
  });

  it("reports a persistent initialization conflict after one recovery retry", async () => {
    const conflict = new Error(
      "reply session initialization conflicted for agent:ops_bot:wecom:acct:dm:alice",
    );
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockRejectedValue(conflict);
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);

    await expect(
      dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: makeStore() as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-conflict", "conflict"),
        replyHandle: makeReplyHandle(),
      }),
    ).rejects.toBe(conflict);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
  });

  it("fails an activated Bot WS reply once when prepare rejects before core starts", async () => {
    const prepareError = new Error("attachment prepare failed");
    const fail = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn();
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);

    await expect(
      dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: makeStore() as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockRejectedValue(prepareError),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-prepare-rejected", "prepare"),
        replyHandle: makeReplyHandle(vi.fn(), { fail }),
      }),
    ).rejects.toBe(prepareError);

    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(prepareError);
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("times out a stuck prepare after 60 seconds", async () => {
    vi.useFakeTimers();
    try {
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn();
      const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
      const activate = vi.fn();
      const fail = vi.fn().mockResolvedValue(undefined);
      const operation = dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: makeStore() as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn(() => new Promise(() => undefined)),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-prepare-timeout", "timeout"),
        replyHandle: makeReplyHandle(vi.fn(), { activate, fail }),
      });
      const rejected = expect(operation).rejects.toMatchObject({
        name: "WeComPrepareTimeoutError",
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(activate).toHaveBeenCalledTimes(1);
      expect(fail).toHaveBeenCalledTimes(1);
      expect(fail.mock.calls[0]?.[0]).toMatchObject({ name: "WeComPrepareTimeoutError" });
      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
