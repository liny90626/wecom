import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReplyHandle } from "../types/index.js";
import {
  getActiveBotWsReplyHandle,
  registerActiveBotWsReplyHandle,
  unregisterActiveBotWsReplyHandle,
} from "./index.js";

function makeReplyHandle(overrides: Partial<ReplyHandle> = {}): ReplyHandle {
  return {
    context: {
      transport: "bot-ws",
      accountId: "acct",
      raw: { transport: "bot-ws", envelopeType: "ws", body: {} },
    },
    deliver: vi.fn(),
    ...overrides,
  };
}

describe("active Bot WS reply handle registry", () => {
  afterEach(() => {
    unregisterActiveBotWsReplyHandle({
      accountId: "acct",
      sessionKey: "session-a",
      peerKind: "direct",
      peerId: "alice",
    });
    unregisterActiveBotWsReplyHandle({
      accountId: "acct",
      sessionKey: "session-b",
      peerKind: "direct",
      peerId: "alice",
    });
  });

  it("supersedes the previous same-peer handle when a new inbound is registered", () => {
    const supersedeByNewInbound = vi.fn();
    const oldHandle = makeReplyHandle({ supersedeByNewInbound });
    const newHandle = makeReplyHandle();

    const firstRegistration = registerActiveBotWsReplyHandle({
      accountId: "acct",
      sessionKey: "session-a",
      peerKind: "direct",
      peerId: "Alice",
      handle: oldHandle,
    });
    const secondRegistration = registerActiveBotWsReplyHandle({
      accountId: "acct",
      sessionKey: "session-b",
      peerKind: "direct",
      peerId: "alice",
      handle: newHandle,
    });

    expect(supersedeByNewInbound).toHaveBeenCalledWith({
      accountId: "acct",
      peerKind: "direct",
      peerId: "alice",
      reason: "new-inbound",
    });
    expect(firstRegistration).toBe(false);
    expect(secondRegistration).toBe(true);
    expect(
      getActiveBotWsReplyHandle({
        accountId: "acct",
        peerKind: "direct",
        peerId: "ALICE",
      }),
    ).toBe(newHandle);

    unregisterActiveBotWsReplyHandle({
      accountId: "acct",
      sessionKey: "session-a",
      peerKind: "direct",
      peerId: "alice",
      handle: oldHandle,
    });
    expect(
      getActiveBotWsReplyHandle({
        accountId: "acct",
        peerKind: "direct",
        peerId: "alice",
      }),
    ).toBe(newHandle);
  });

  it("registers the new handle even when the previous supersede callback throws", () => {
    const oldHandle = makeReplyHandle({
      supersedeByNewInbound: vi.fn(() => {
        throw new Error("old handle cleanup failed");
      }),
    });
    const newHandle = makeReplyHandle();
    registerActiveBotWsReplyHandle({
      accountId: "acct",
      sessionKey: "session-a",
      peerKind: "direct",
      peerId: "alice",
      handle: oldHandle,
    });

    expect(
      registerActiveBotWsReplyHandle({
        accountId: "acct",
        sessionKey: "session-b",
        peerKind: "direct",
        peerId: "alice",
        handle: newHandle,
      }),
    ).toBe(true);
    expect(
      getActiveBotWsReplyHandle({
        accountId: "acct",
        peerKind: "direct",
        peerId: "alice",
      }),
    ).toBe(newHandle);
  });
});
