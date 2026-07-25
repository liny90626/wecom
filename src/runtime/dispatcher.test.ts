import { describe, expect, it, vi } from "vitest";

const openClawHandoffState = vi.hoisted(() => ({
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  abortAndDrainAgentHarnessRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => openClawHandoffState);

import { dispatchInboundEvent } from "./dispatcher.js";
import type { ReplyHandle, UnifiedInboundEvent } from "../types/index.js";
import {
  getActiveBotWsReplyHandle,
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
  readSessionUpdatedAt = () => undefined as number | undefined,
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
        readSessionUpdatedAt,
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

  it("deduplicates a media id consumed by a merged text event", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
    const store = makeStore();
    const auditLog = { appendOperational: vi.fn(), appendInbound: vi.fn() };
    const common = {
      core: core as any,
      cfg: {} as any,
      store: store as any,
      auditLog: auditLog as any,
      mediaService: {
        normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
        saveInboundAttachment: vi.fn(),
      } as any,
    };
    const mergedEvent = {
      ...makeEvent("msg-merged-text", "分析附件"),
      dedupeAliases: ["msg-merged-file"],
    };

    await dispatchInboundEvent({
      ...common,
      event: mergedEvent,
      replyHandle: makeReplyHandle(),
    });
    await dispatchInboundEvent({
      ...common,
      event: makeEvent("msg-merged-file", "[file] report.pdf"),
      replyHandle: makeReplyHandle(),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(auditLog.appendOperational).toHaveBeenCalledWith(
      expect.objectContaining({ category: "duplicate-inbound", messageId: "msg-merged-file" }),
    );
  });

  it("acknowledges a Bot WS inbound before its session prepare finishes", async () => {
    // v118 opened the placeholder the moment the frame arrived. Waiting for the
    // prepare (media download, cold-session metadata) leaves a file upload with
    // no visible feedback for as long as the download takes.
    let releaseAttachment!: () => void;
    const attachment = new Promise<undefined>((resolve) => {
      releaseAttachment = () => resolve(undefined);
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
    const startPlaceholder = vi.fn();
    const activate = vi.fn();

    const dispatch = dispatchInboundEvent({
      core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
      cfg: {} as any,
      store: makeStore() as any,
      auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
      mediaService: {
        normalizeFirstAttachment: vi.fn(() => attachment),
        saveInboundAttachment: vi.fn(),
      } as any,
      event: makeEvent("msg-slow-prepare-ack", "分析这个文件"),
      replyHandle: makeReplyHandle(vi.fn(), { startPlaceholder, activate }),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(startPlaceholder).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    releaseAttachment();
    await dispatch;

    expect(activate).toHaveBeenCalledTimes(1);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("carries a pending message superseded during prepare into the successor", async () => {
    // The pending layer aborts a message that has not reached OpenClaw yet. Its
    // text and attachments must move to the newer inbound, otherwise a file
    // whose download outlives the next message is silently lost while the user
    // is told the messages were merged.
    let releaseAttachment!: () => void;
    const attachment = new Promise<undefined>((resolve) => {
      releaseAttachment = () => resolve(undefined);
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
    const store = makeStore();
    const auditLog = { appendOperational: vi.fn(), appendInbound: vi.fn() };
    const successorMedia = {
      normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
      saveInboundAttachment: vi.fn(),
    };
    const fileEvent = {
      ...makeEvent("msg-pending-file", "[file] report.pdf"),
      inboundKind: "file" as const,
      attachments: [{ name: "report.pdf", remoteUrl: "https://wecom/report.pdf" }],
    };

    const first = dispatchInboundEvent({
      core: core as any,
      cfg: {} as any,
      store: store as any,
      auditLog: auditLog as any,
      mediaService: {
        normalizeFirstAttachment: vi.fn(() => attachment),
        saveInboundAttachment: vi.fn(),
      } as any,
      event: fileEvent,
      replyHandle: makeReplyHandle(),
    });
    await Promise.resolve();

    const second = dispatchInboundEvent({
      core: core as any,
      cfg: {} as any,
      store: store as any,
      auditLog: auditLog as any,
      mediaService: successorMedia as any,
      event: makeEvent("msg-pending-question", "这个文件讲了什么？"),
      replyHandle: makeReplyHandle(),
    });

    await first;
    releaseAttachment();
    await second;

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    const body = String(
      dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx?.Body ?? "",
    );
    expect(body).toContain("[file] report.pdf");
    expect(body).toContain("这个文件讲了什么？");
    expect(successorMedia.normalizeFirstAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expect.objectContaining({ remoteUrl: "https://wecom/report.pdf" })],
      }),
    );
  });

  it("does not fold a busy-rejected message into the next inbound", async () => {
    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-finishing");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockResolvedValue({
      aborted: false,
      drained: false,
      forceCleared: false,
    });
    let releaseNotice!: () => void;
    const noticeDelivered = new Promise<void>((resolve) => {
      releaseNotice = resolve;
    });
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

    try {
      const rejected = dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: store as any,
        auditLog: auditLog as any,
        mediaService: mediaService as any,
        event: makeEvent("msg-busy-rejected", "被拒绝的指令"),
        replyHandle: makeReplyHandle(vi.fn(), {
          deliver: vi.fn(() => noticeDelivered),
        }),
      });
      await vi.waitFor(() =>
        expect(openClawHandoffState.abortAndDrainAgentHarnessRun).toHaveBeenCalled(),
      );
      await Promise.resolve();

      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
      await dispatchInboundEvent({
        core: core as any,
        cfg: {} as any,
        store: store as any,
        auditLog: auditLog as any,
        mediaService: mediaService as any,
        event: makeEvent("msg-after-busy", "新的指令"),
        replyHandle: makeReplyHandle(),
      });
      releaseNotice();
      await rejected;

      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
      expect(
        String(dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx?.Body ?? ""),
      ).toBe("新的指令");
    } finally {
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
    }
  });

  it("never merges a superseded pending message from another group member", async () => {
    let releaseAttachment!: () => void;
    const attachment = new Promise<undefined>((resolve) => {
      releaseAttachment = () => resolve(undefined);
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
    const store = makeStore();
    const auditLog = { appendOperational: vi.fn(), appendInbound: vi.fn() };
    const groupEvent = (messageId: string, senderId: string, text: string) => ({
      ...makeEvent(messageId, text),
      conversation: {
        accountId: "acct",
        peerKind: "group" as const,
        peerId: "room-1",
        senderId,
      },
    });

    const first = dispatchInboundEvent({
      core: core as any,
      cfg: {} as any,
      store: store as any,
      auditLog: auditLog as any,
      mediaService: {
        normalizeFirstAttachment: vi.fn(() => attachment),
        saveInboundAttachment: vi.fn(),
      } as any,
      event: groupEvent("msg-group-bob", "bob", "bob 的私事"),
      replyHandle: makeReplyHandle(),
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
      event: groupEvent("msg-group-carol", "carol", "carol 的问题"),
      replyHandle: makeReplyHandle(),
    });

    await first;
    releaseAttachment();
    await second;

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    const body = String(
      dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx?.Body ?? "",
    );
    expect(body).toBe("carol 的问题");
  });

  it("supersedes the previous handle before activating its successor", async () => {
    const lifecycle: string[] = [];
    registerActiveBotWsReplyHandle({
      accountId: "acct",
      peerKind: "direct",
      peerId: "alice",
      handle: makeReplyHandle(() => {
        lifecycle.push("supersede");
      }),
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });

    await dispatchInboundEvent({
      core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
      cfg: {} as any,
      store: makeStore() as any,
      auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
      mediaService: {
        normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
        saveInboundAttachment: vi.fn(),
      } as any,
      event: makeEvent("msg-ordered-activation", "接管旧任务"),
      replyHandle: makeReplyHandle(vi.fn(), {
        activate: () => {
          lifecycle.push("activate");
        },
      }),
    });

    expect(lifecycle.slice(0, 2)).toEqual(["supersede", "activate"]);
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

  it("aborts an active core dispatch when its Bot WS runtime retires", async () => {
    let retireTransport!: () => void;
    let coreAbortSignal: AbortSignal | undefined;
    const removeRetireListener = vi.fn();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation((params) => {
      coreAbortSignal = params.replyOptions.abortSignal;
      return new Promise((_resolve, reject) => {
        coreAbortSignal?.addEventListener(
          "abort",
          () => reject(coreAbortSignal?.reason),
          { once: true },
        );
      });
    });
    const operation = dispatchInboundEvent({
      core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
      cfg: {} as any,
      store: makeStore() as any,
      auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
      mediaService: {
        normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
        saveInboundAttachment: vi.fn(),
      } as any,
      event: makeEvent("msg-runtime-retired", "long task"),
      replyHandle: makeReplyHandle(vi.fn(), {
        onTransportRetired: (listener) => {
          retireTransport = listener;
          return removeRetireListener;
        },
      }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    retireTransport();
    await operation;

    expect(coreAbortSignal?.aborted).toBe(true);
    expect(removeRetireListener).toHaveBeenCalledOnce();
  });

  it("does not enter core when the Bot WS runtime retires during prepare", async () => {
    let retireTransport!: () => void;
    const normalizeFirstAttachment = vi.fn(() => new Promise(() => undefined));
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn();
    const operation = dispatchInboundEvent({
      core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
      cfg: {} as any,
      store: makeStore() as any,
      auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
      mediaService: {
        normalizeFirstAttachment,
        saveInboundAttachment: vi.fn(),
      } as any,
      event: makeEvent("msg-runtime-retired-during-prepare", "prepare"),
      replyHandle: makeReplyHandle(vi.fn(), {
        onTransportRetired: (listener) => {
          retireTransport = listener;
          return vi.fn();
        },
      }),
    });
    await vi.waitFor(() => expect(normalizeFirstAttachment).toHaveBeenCalledOnce());

    retireTransport();
    await operation;

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("keeps transport owner tracking until an aborted core dispatch actually settles", async () => {
    let settleFirstCore!: () => void;
    const firstCore = new Promise<{ queuedFinal: true; counts: { block: 0; final: 1; tool: 0 } }>(
      (resolve) => {
        settleFirstCore = () =>
          resolve({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
      },
    );
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementationOnce(() => firstCore)
      .mockResolvedValueOnce({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);
    const store = makeStore();
    const auditLog = { appendOperational: vi.fn(), appendInbound: vi.fn() };
    const mediaService = {
      normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
      saveInboundAttachment: vi.fn(),
    };
    const markFirstDispatchSettled = vi.fn();

    const first = dispatchInboundEvent({
      core: core as any,
      cfg: {} as any,
      store: store as any,
      auditLog: auditLog as any,
      mediaService: mediaService as any,
      event: makeEvent("msg-owner-tracking-a", "A"),
      replyHandle: makeReplyHandle(vi.fn(), {
        markDispatchSettled: markFirstDispatchSettled,
      }),
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
      event: makeEvent("msg-owner-tracking-b", "B"),
      replyHandle: makeReplyHandle(),
    });
    await first;

    expect(markFirstDispatchSettled).not.toHaveBeenCalled();
    settleFirstCore();
    await vi.waitFor(() => expect(markFirstDispatchSettled).toHaveBeenCalledOnce());
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

    // No lingering run exists before the first dispatch; "run-a" only becomes
    // resolvable once the first core dispatch is running.
    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockImplementation(() =>
      dispatchCount >= 1 ? "run-a" : undefined,
    );
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

  it("keeps the successor behind the barrier while a superseded pre-dispatch drain is in flight", async () => {
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    let drainCalls = 0;
    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-lingering");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockImplementation(async () => {
      drainCalls += 1;
      if (drainCalls === 1) {
        await drainGate;
      }
      return { aborted: true, drained: true, forceCleared: false };
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      await params.dispatcherOptions.deliver({ text: "后继消息完成" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
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
        event: makeEvent("msg-barrier-drain-a", "A"),
        replyHandle: makeReplyHandle(),
      });
      // First message is parked inside its pre-dispatch drain.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drainCalls).toBe(1);
      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

      const second = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-barrier-drain-b", "B"),
        replyHandle: makeReplyHandle(),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      // The successor must not reach core while the superseded message's
      // drain is still in flight — its abort could land on the new run.
      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

      releaseDrain();
      await Promise.allSettled([first, second]);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    } finally {
      releaseDrain();
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
    }
  });

  it("does not drain or retry a superseded dispatch that fails with an admission error", async () => {
    // Regression: the detached handoff-retry continuation of a superseded
    // dispatch must not abort the session again — by then the sessionKey can
    // already belong to the successor's freshly started run.
    let rejectFirst!: (error: Error) => void;
    const admissionError = new Error(
      'Session "agent:ops_bot:wecom:acct:dm:alice" changed while starting work. Retry.',
    );
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "后续消息完成" }, { kind: "final" });
        return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
      });
    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-live");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockResolvedValue({
      aborted: true,
      drained: true,
      forceCleared: false,
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
      const firstFail = vi.fn().mockResolvedValue(undefined);
      const first = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-orphan-a", "long task"),
        replyHandle: makeReplyHandle(vi.fn(), { fail: firstFail }),
      });
      await vi.waitFor(() =>
        expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1),
      );

      await dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-orphan-b", "newer message"),
        replyHandle: makeReplyHandle(),
      });
      await first;
      const drainCallsBeforeOrphan =
        openClawHandoffState.abortAndDrainAgentHarnessRun.mock.calls.length;

      rejectFirst(admissionError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(openClawHandoffState.abortAndDrainAgentHarnessRun).toHaveBeenCalledTimes(
        drainCallsBeforeOrphan,
      );
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      expect(firstFail).not.toHaveBeenCalled();
    } finally {
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
    }
  });

  it("rejects a busy inbound without force clearing or entering OpenClaw", async () => {
    // OpenClaw ≥2026.7.1 freezes abort during a run's delivery phase, so a
    // refused graceful abort usually means a HEALTHY dispatch is finishing.
    // Force-clearing it would stamp the run "run_failed" and surface the
    // generic core failure text in the chat.
    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-finishing");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockResolvedValue({
      aborted: false,
      drained: false,
      forceCleared: false,
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn();
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);

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
        event: makeEvent("msg-no-force-clear", "新消息"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver }),
      });

      expect(openClawHandoffState.abortAndDrainAgentHarnessRun).toHaveBeenCalledTimes(1);
      const drainParams = openClawHandoffState.abortAndDrainAgentHarnessRun.mock.calls[0]?.[0];
      expect(drainParams?.forceClear).not.toBe(true);
      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledWith(
        { text: expect.stringContaining("确认新指令未执行后再重试") },
        { kind: "final" },
      );
    } finally {
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
    }
  });

  it("continues admission when the old run accepted abort but is still draining", async () => {
    vi.useFakeTimers();
    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-aborting");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockResolvedValue({
      aborted: true,
      drained: false,
      forceCleared: false,
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValueOnce({
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      })
      .mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "新任务已接管" }, { kind: "final" });
        return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
      });

    try {
      const operation = dispatchInboundEvent({
        core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
        cfg: {} as any,
        store: makeStore() as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-abort-accepted", "新消息"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver }),
      });
      await vi.advanceTimersByTimeAsync(500);
      await operation;

      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      expect(deliver).toHaveBeenCalledWith({ text: "新任务已接管" }, { kind: "final" });
    } finally {
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
      vi.useRealTimers();
    }
  });

  it("reports busy once after one flagless busy retry", async () => {
    vi.useFakeTimers();
    openClawHandoffState.resolveActiveEmbeddedRunSessionId
      .mockReturnValueOnce(undefined)
      .mockReturnValue("run-still-busy");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockResolvedValue({
      aborted: false,
      drained: false,
      forceCleared: false,
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    try {
      const operation = dispatchInboundEvent({
        core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
        cfg: {} as any,
        store: makeStore() as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-persistent-flagless-busy", "新消息"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver, fail }),
      });
      await vi.advanceTimersByTimeAsync(500);
      await operation;

      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver).toHaveBeenCalledWith(
        { text: expect.stringContaining("确认新指令未执行后再重试") },
        { kind: "final" },
      );
      expect(fail).not.toHaveBeenCalled();
    } finally {
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
      vi.useRealTimers();
    }
  });

  it("fails once when the post-retry busy notice cannot be delivered", async () => {
    vi.useFakeTimers();
    openClawHandoffState.resolveActiveEmbeddedRunSessionId
      .mockReturnValueOnce(undefined)
      .mockReturnValue("run-still-busy");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockResolvedValue({
      aborted: false,
      drained: false,
      forceCleared: false,
    });
    const noticeError = new Error("busy notice delivery failed");
    const deliver = vi.fn().mockRejectedValue(noticeError);
    const fail = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    try {
      const operation = dispatchInboundEvent({
        core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
        cfg: {} as any,
        store: makeStore() as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-busy-notice-fails", "新消息"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver, fail }),
      });
      const outcome = operation.then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );
      await vi.advanceTimersByTimeAsync(500);

      await expect(outcome).resolves.toEqual({ ok: false, error: noticeError });
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      expect(deliver).toHaveBeenCalledOnce();
      expect(fail).toHaveBeenCalledOnce();
      expect(fail).toHaveBeenCalledWith(noticeError);
    } finally {
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
      vi.useRealTimers();
    }
  });

  it("preserves the old final when a busy run cannot accept the new inbound", async () => {
    let releaseOldRun!: () => void;
    const oldRunGate = new Promise<void>((resolve) => {
      releaseOldRun = resolve;
    });
    let oldAbortSignal: AbortSignal | undefined;
    const oldDeliver = vi.fn().mockResolvedValue(undefined);
    const oldSupersede = vi.fn();
    const busyDeliver = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async (params) => {
      oldAbortSignal = params.replyOptions.abortSignal;
      await oldRunGate;
      await params.dispatcherOptions.deliver({ text: "旧任务最终结果" }, { kind: "final" });
      return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
    });
    openClawHandoffState.resolveActiveEmbeddedRunSessionId
      .mockReturnValueOnce(undefined)
      .mockReturnValue("run-finishing");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockResolvedValue({
      aborted: false,
      drained: false,
      forceCleared: false,
    });
    const common = {
      core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
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
        event: makeEvent("msg-preserve-old-a", "long task"),
        replyHandle: makeReplyHandle(oldSupersede, { deliver: oldDeliver }),
      });
      await vi.waitFor(() =>
        expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce(),
      );

      await dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-preserve-old-b", "new instruction"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver: busyDeliver }),
      });

      expect(oldSupersede).not.toHaveBeenCalled();
      expect(oldAbortSignal?.aborted).toBe(false);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
      expect(busyDeliver).toHaveBeenCalledWith(
        { text: expect.stringContaining("确认新指令未执行后再重试") },
        { kind: "final" },
      );

      releaseOldRun();
      await first;
      expect(oldDeliver).toHaveBeenCalledWith({ text: "旧任务最终结果" }, { kind: "final" });
    } finally {
      releaseOldRun();
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
    }
  });

  it("reports that a busy inbound was not accepted after the lingering run refuses abort", async () => {
    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReturnValue("run-busy");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockResolvedValue({
      aborted: false,
      drained: false,
      forceCleared: false,
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const core = makeCore(dispatchReplyWithBufferedBlockDispatcher);

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
        event: makeEvent("msg-absorbed", "目前徕事找晓艳了吗？"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver, fail }),
      });

      expect(fail).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledTimes(1);
      const [payload, info] = deliver.mock.calls[0] ?? [];
      expect(info).toEqual({ kind: "final" });
      expect(String(payload?.text)).toContain("确认新指令未执行后再重试");
    } finally {
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
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
    const staleHandle = makeReplyHandle(vi.fn(), {
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
      await vi.advanceTimersByTimeAsync(5_000);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await operation;
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    } finally {
      unregisterActiveBotWsReplyHandle(registration);
      vi.useRealTimers();
    }
  });

  it("still drains a stale core run when the previous handle settled before dispatch", async () => {
    const staleRegistration = {
      accountId: "acct",
      peerKind: "direct" as const,
      peerId: "alice",
      sessionKey: "stale-session",
      handle: makeReplyHandle(vi.fn(), {
        waitForSupersede: () => Promise.resolve(),
      }),
    };
    registerActiveBotWsReplyHandle(staleRegistration);
    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReturnValue("stale-core-run");
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockResolvedValue({
      aborted: true,
      drained: true,
      forceCleared: false,
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: true,
      counts: { block: 0, final: 1, tool: 0 },
    });

    try {
      await dispatchInboundEvent({
        core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
        cfg: {} as any,
        store: makeStore() as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-pre-core-stale-run", "new message"),
        replyHandle: makeReplyHandle(),
      });

      expect(openClawHandoffState.abortAndDrainAgentHarnessRun).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "stale-core-run" }),
      );
    } finally {
      unregisterActiveBotWsReplyHandle(staleRegistration);
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
    }
  });

  it("does not propagate a timed-out handoff barrier into every later generation", async () => {
    vi.useFakeTimers();
    const staleRegistration = {
      accountId: "acct",
      peerKind: "direct" as const,
      peerId: "alice",
      sessionKey: "stale-session",
      handle: makeReplyHandle(vi.fn(), {
        waitForSupersede: () => new Promise<void>(() => undefined),
      }),
    };
    registerActiveBotWsReplyHandle(staleRegistration);
    let dispatchCount = 0;
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation((params) => {
      dispatchCount += 1;
      if (dispatchCount < 3) {
        return new Promise((_resolve, reject) => {
          params.replyOptions.abortSignal.addEventListener(
            "abort",
            () => reject(params.replyOptions.abortSignal.reason),
            { once: true },
          );
        });
      }
      return params.dispatcherOptions
        .deliver({ text: "latest" }, { kind: "final" })
        .then(() => ({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } }));
    });
    const common = {
      core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
      cfg: {} as any,
      store: makeStore() as any,
      auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
      mediaService: {
        normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
        saveInboundAttachment: vi.fn(),
      } as any,
    };

    try {
      const second = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-generation-b", "B"),
        replyHandle: makeReplyHandle(),
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

      const third = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-generation-c", "C"),
        replyHandle: makeReplyHandle(),
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);

      const latestDeliver = vi.fn().mockResolvedValue(undefined);
      const latest = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-generation-d", "D"),
        replyHandle: makeReplyHandle(vi.fn(), { deliver: latestDeliver }),
      });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(3);
      await Promise.allSettled([second, third, latest]);
      expect(latestDeliver).toHaveBeenCalledWith({ text: "latest" }, { kind: "final" });
    } finally {
      unregisterActiveBotWsReplyHandle(staleRegistration);
      vi.useRealTimers();
    }
  });

  it("bounds a superseded OpenClaw drain that never resolves", async () => {
    vi.useFakeTimers();
    openClawHandoffState.resolveActiveEmbeddedRunSessionId
      .mockReturnValueOnce(undefined)
      .mockReturnValue("run-never-drains");
    openClawHandoffState.abortAndDrainAgentHarnessRun
      .mockResolvedValueOnce({ aborted: true, drained: true, forceCleared: false })
      .mockImplementationOnce(() => new Promise(() => undefined));
    let dispatchCount = 0;
    let settleFirstCore!: () => void;
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(() => {
      dispatchCount += 1;
      if (dispatchCount === 1) {
        return new Promise((resolve) => {
          settleFirstCore = () =>
            resolve({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
        });
      }
      return Promise.resolve({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
    });
    const common = {
      core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
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
        event: makeEvent("msg-never-drain-a", "A"),
        replyHandle: makeReplyHandle(),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      const firstHandle = getActiveBotWsReplyHandle({
        accountId: "acct",
        peerKind: "direct",
        peerId: "alice",
      });
      const second = dispatchInboundEvent({
        ...common,
        event: makeEvent("msg-never-drain-b", "B"),
        replyHandle: makeReplyHandle(),
      });
      await vi.advanceTimersByTimeAsync(0);
      const barrier = firstHandle?.waitForSupersede?.();
      let barrierSettled = false;
      void barrier?.then(() => {
        barrierSettled = true;
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(barrierSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(barrierSettled).toBe(true);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      settleFirstCore();
      await Promise.allSettled([first, second]);
    } finally {
      settleFirstCore?.();
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
      vi.useRealTimers();
    }
  });

  it("bounds a never-resolving initialization-conflict drain before retrying", async () => {
    vi.useFakeTimers();
    const conflict = new Error(
      "reply session initialization conflicted for agent:ops_bot:wecom:acct:dm:alice",
    );
    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } });
    openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockImplementation(() =>
      dispatchReplyWithBufferedBlockDispatcher.mock.calls.length > 0 ? "run-conflict" : undefined,
    );
    openClawHandoffState.abortAndDrainAgentHarnessRun.mockImplementation(
      () => new Promise(() => undefined),
    );

    try {
      const operation = dispatchInboundEvent({
        core: makeCore(dispatchReplyWithBufferedBlockDispatcher) as any,
        cfg: {} as any,
        store: makeStore() as any,
        auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
        mediaService: {
          normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
          saveInboundAttachment: vi.fn(),
        } as any,
        event: makeEvent("msg-conflict-never-drain", "conflict"),
        replyHandle: makeReplyHandle(),
      });
      await vi.advanceTimersByTimeAsync(5_500);

      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      await operation;
    } finally {
      openClawHandoffState.resolveActiveEmbeddedRunSessionId.mockReset();
      openClawHandoffState.abortAndDrainAgentHarnessRun.mockReset();
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

  it("does not let warm-session metadata stall core dispatch", async () => {
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
    const core = makeCore(
      dispatchReplyWithBufferedBlockDispatcher,
      recordInboundSession,
      () => Date.now() - 1_000,
    );
    const operation = dispatchInboundEvent({
      core: core as any,
      cfg: {} as any,
      store: makeStore() as any,
      auditLog: { appendOperational: vi.fn(), appendInbound: vi.fn() } as any,
      mediaService: {
        normalizeFirstAttachment: vi.fn().mockResolvedValue(undefined),
        saveInboundAttachment: vi.fn(),
      } as any,
      event: makeEvent("msg-warm-metadata-stall", "warm"),
      replyHandle: makeReplyHandle(),
    });

    await vi.waitFor(() => expect(recordInboundSession).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    const dispatchedBeforeMetadataSettled =
      dispatchReplyWithBufferedBlockDispatcher.mock.calls.length === 1;

    releaseMetadata();
    await operation;

    expect(dispatchedBeforeMetadataSettled).toBe(true);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
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
      expect(activate).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledTimes(1);
      expect(fail.mock.calls[0]?.[0]).toMatchObject({ name: "WeComPrepareTimeoutError" });
      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
