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
});
