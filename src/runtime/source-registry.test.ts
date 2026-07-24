import { afterEach, describe, expect, it } from "vitest";

import {
  clearWecomSourceAccount,
  registerWecomSourceSnapshot,
  resolveWecomSourceSnapshot,
} from "./source-registry.js";

describe("WeCom source registry account isolation", () => {
  afterEach(() => {
    clearWecomSourceAccount("account-a");
    clearWecomSourceAccount("account-b");
  });

  it("does not resolve another account's loose session when accountId is known", () => {
    registerWecomSourceSnapshot({
      accountId: "account-b",
      source: "bot-ws",
      sessionKey: "shared-session",
    });

    expect(
      resolveWecomSourceSnapshot({
        accountId: "account-a",
        sessionKey: "shared-session",
      }),
    ).toBeUndefined();
  });

  it("prefers the known account's conversation over another account's loose session", () => {
    registerWecomSourceSnapshot({
      accountId: "account-a",
      source: "agent-callback",
      peerKind: "direct",
      peerId: "shared-peer",
    });
    registerWecomSourceSnapshot({
      accountId: "account-b",
      source: "bot-ws",
      sessionKey: "shared-session",
    });

    expect(
      resolveWecomSourceSnapshot({
        accountId: "account-a",
        sessionKey: "shared-session",
        peerKind: "direct",
        peerId: "shared-peer",
      })?.source,
    ).toBe("agent-callback");
  });

  it("keeps a refreshed conversation when the bounded registry evicts its oldest entry", () => {
    registerWecomSourceSnapshot({
      accountId: "account-a",
      source: "bot-ws",
      peerKind: "direct",
      peerId: "active-peer",
    });
    for (let index = 0; index < 1_023; index += 1) {
      registerWecomSourceSnapshot({
        accountId: "account-a",
        source: "bot-ws",
        peerKind: "direct",
        peerId: `peer-${index}`,
      });
    }

    registerWecomSourceSnapshot({
      accountId: "account-a",
      source: "bot-ws",
      peerKind: "direct",
      peerId: "active-peer",
    });
    registerWecomSourceSnapshot({
      accountId: "account-a",
      source: "bot-ws",
      peerKind: "direct",
      peerId: "overflow-peer",
    });

    expect(
      resolveWecomSourceSnapshot({
        accountId: "account-a",
        peerKind: "direct",
        peerId: "active-peer",
      })?.source,
    ).toBe("bot-ws");
  });
});
