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
});
