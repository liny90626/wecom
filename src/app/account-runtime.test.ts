import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplyHandle, UnifiedInboundEvent } from "../types/index.js";

const { dispatchInboundEventMock } = vi.hoisted(() => ({
  dispatchInboundEventMock: vi.fn(),
}));

vi.mock("../runtime/dispatcher.js", () => ({
  dispatchInboundEvent: dispatchInboundEventMock,
}));

import { WecomAccountRuntime } from "./account-runtime.js";

function makeRuntime(): WecomAccountRuntime {
  return new WecomAccountRuntime(
    {} as any,
    {} as any,
    { account: { accountId: "acct" } } as any,
  );
}

function makeEvent(): UnifiedInboundEvent {
  return {
    accountId: "acct",
    capability: "bot",
    transport: "bot-ws",
    inboundKind: "text",
    messageId: "msg-1",
    conversation: {
      accountId: "acct",
      peerKind: "direct",
      peerId: "alice",
      senderId: "alice",
    },
    text: "hello",
    timestamp: Date.now(),
    raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
    replyContext: {
      transport: "bot-ws",
      accountId: "acct",
      raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
    },
  };
}

describe("WecomAccountRuntime", () => {
  beforeEach(() => {
    dispatchInboundEventMock.mockReset();
  });

  it("forwards supersedeByNewInbound through the runtime tracking wrapper", async () => {
    let trackedReplyHandle: ReplyHandle | undefined;
    dispatchInboundEventMock.mockImplementation(async (params: { replyHandle: ReplyHandle }) => {
      trackedReplyHandle = params.replyHandle;
    });
    const supersedeByNewInbound = vi.fn();
    const runtime = makeRuntime();

    await runtime.handleEvent(makeEvent(), {
      context: {
        transport: "bot-ws",
        accountId: "acct",
        raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
      },
      deliver: vi.fn(),
      supersedeByNewInbound,
    });

    trackedReplyHandle?.supersedeByNewInbound?.({
      accountId: "acct",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });

    expect(supersedeByNewInbound).toHaveBeenCalledWith({
      accountId: "acct",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
  });

  it("forwards reply activation through the runtime wrapper", async () => {
    let trackedReplyHandle: ReplyHandle | undefined;
    dispatchInboundEventMock.mockImplementation(async (params: { replyHandle: ReplyHandle }) => {
      trackedReplyHandle = params.replyHandle;
    });
    const activate = vi.fn();

    await makeRuntime().handleEvent(makeEvent(), {
      context: {
        transport: "bot-ws",
        accountId: "acct",
        raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
      },
      deliver: vi.fn(),
      activate,
    });

    trackedReplyHandle?.activate?.();
    expect(activate).toHaveBeenCalledOnce();
  });

  it("forwards transport lifecycle hooks through the runtime wrapper", async () => {
    let trackedReplyHandle: ReplyHandle | undefined;
    dispatchInboundEventMock.mockImplementation(async (params: { replyHandle: ReplyHandle }) => {
      trackedReplyHandle = params.replyHandle;
    });
    const unregister = vi.fn();
    const onTransportRetired = vi.fn(() => unregister);
    const markDispatchSettled = vi.fn();

    await makeRuntime().handleEvent(makeEvent(), {
      context: {
        transport: "bot-ws",
        accountId: "acct",
        raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
      },
      deliver: vi.fn(),
      onTransportRetired,
      markDispatchSettled,
    });

    const listener = vi.fn();
    expect(trackedReplyHandle?.onTransportRetired?.(listener)).toBe(unregister);
    trackedReplyHandle?.markDispatchSettled?.();

    expect(onTransportRetired).toHaveBeenCalledWith(listener);
    expect(markDispatchSettled).toHaveBeenCalledOnce();
  });

  it("records a handled Bot WS reply failure once across runtime and frame boundaries", async () => {
    const replyError = new Error("WeCom Bot WS reply produced no visible output");
    dispatchInboundEventMock.mockImplementation(
      async (params: { replyHandle: ReplyHandle }) => {
        await params.replyHandle.fail?.(replyError);
        throw replyError;
      },
    );
    const runtime = makeRuntime();
    const recordOperationalIssue = vi.spyOn(runtime, "recordOperationalIssue");
    const fail = vi.fn().mockResolvedValue(undefined);
    let frameBoundaryError: unknown;

    try {
      await runtime.handleEvent(makeEvent(), {
        context: {
          transport: "bot-ws",
          accountId: "acct",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver: vi.fn(),
        fail,
      });
    } catch (error) {
      // Mirrors BotWsSdkAdapter.reportFrameError, which records any error that
      // escapes the account runtime as a second operational issue.
      frameBoundaryError = error;
      runtime.recordOperationalIssue({
        transport: "bot-ws",
        category: "runtime-error",
        summary: "bot-ws frame handler crashed",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(replyError);
    expect(recordOperationalIssue).toHaveBeenCalledOnce();
    expect(frameBoundaryError).toBeUndefined();
  });

  it("still propagates a Bot WS error that bypassed the reply failure handler", async () => {
    const dispatchError = new Error("unhandled dispatch crash");
    dispatchInboundEventMock.mockRejectedValue(dispatchError);

    await expect(
      makeRuntime().handleEvent(makeEvent(), {
        context: {
          transport: "bot-ws",
          accountId: "acct",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver: vi.fn(),
        fail: vi.fn(),
      }),
    ).rejects.toBe(dispatchError);
  });

  it("still propagates a distinct Bot WS crash after a reply failure was handled", async () => {
    const replyError = new Error("WeCom Bot WS reply produced no visible output");
    const dispatchError = new Error("crashed after handling the reply failure");
    dispatchInboundEventMock.mockImplementation(
      async (params: { replyHandle: ReplyHandle }) => {
        await params.replyHandle.fail?.(replyError);
        throw dispatchError;
      },
    );
    const runtime = makeRuntime();
    const recordOperationalIssue = vi.spyOn(runtime, "recordOperationalIssue");
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(
      runtime.handleEvent(makeEvent(), {
        context: {
          transport: "bot-ws",
          accountId: "acct",
          raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
        },
        deliver: vi.fn(),
        fail,
      }),
    ).rejects.toBe(dispatchError);

    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(replyError);
    expect(recordOperationalIssue).toHaveBeenCalledOnce();
  });
});
