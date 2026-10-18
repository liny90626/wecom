import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAgentAccount } from "../../types/index.js";

const { wecomFetchMock } = vi.hoisted(() => ({ wecomFetchMock: vi.fn() }));

vi.mock("../../http.js", () => ({
  wecomFetch: wecomFetchMock,
  readResponseBodyAsBuffer: vi.fn(),
}));

vi.mock("../../config/index.js", () => ({
  resolveWecomEgressProxyUrlFromNetwork: () => undefined,
}));

import { sendText } from "./core.js";
import { WecomDocClient } from "../../capability/doc/client.js";

let corpCounter = 0;
function createAgent(corpSecret = "secret"): ResolvedAgentAccount {
  corpCounter += 1;
  return {
    accountId: "acct",
    configured: true,
    corpId: `corp-${corpCounter}`,
    corpSecret,
    agentId: 1000,
    token: "token",
    encodingAESKey: "aes",
    config: {} as any,
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function routeFetch(handlers: { token: () => unknown; api: () => unknown }) {
  wecomFetchMock.mockImplementation(async (url: string) =>
    json(url.includes("/gettoken") ? handlers.token() : handlers.api()),
  );
}

const tokenCalls = () =>
  wecomFetchMock.mock.calls.filter((call) => String(call[0]).includes("/gettoken")).length;
const apiCalls = () =>
  wecomFetchMock.mock.calls.filter((call) => !String(call[0]).includes("/gettoken"));

describe("agent API access token", () => {
  beforeEach(() => {
    wecomFetchMock.mockReset();
  });

  it("drops a rejected token and sends once more with a fresh one", async () => {
    // A revoked or early-expired token used to be kept until its nominal
    // expiry, so every agent reply failed for up to two hours.
    let issued = 0;
    const apiResults = [{ errcode: 42001, errmsg: "access_token expired" }, { errcode: 0 }];
    routeFetch({
      token: () => ({ access_token: `tok-${++issued}`, expires_in: 7200 }),
      api: () => apiResults.shift(),
    });

    await sendText({ agent: createAgent(), toUser: "alice", text: "hi" });

    expect(tokenCalls()).toBe(2);
    expect(apiCalls().map((call) => String(call[0]))).toEqual([
      expect.stringContaining("access_token=tok-1"),
      expect.stringContaining("access_token=tok-2"),
    ]);
  });

  it("retries a rejected token only once", async () => {
    let issued = 0;
    routeFetch({
      token: () => ({ access_token: `tok-${++issued}`, expires_in: 7200 }),
      api: () => ({ errcode: 40014, errmsg: "invalid access_token" }),
    });

    await expect(sendText({ agent: createAgent(), toUser: "alice", text: "hi" })).rejects.toThrow(
      "40014",
    );
    expect(apiCalls()).toHaveLength(2);
  });

  it("does not reuse a token issued for a secret that has since been rotated", async () => {
    let issued = 0;
    routeFetch({
      token: () => ({ access_token: `tok-${++issued}`, expires_in: 7200 }),
      api: () => ({ errcode: 0 }),
    });
    const before = createAgent("old-secret");
    await sendText({ agent: before, toUser: "alice", text: "hi" });
    await sendText({ agent: { ...before, corpSecret: "new-secret" }, toUser: "alice", text: "hi" });

    expect(tokenCalls()).toBe(2);
  });

  it("does not repeat a doc write that failed", async () => {
    // Every doc API is a POST and most of them create something; a call that
    // timed out after WeCom ran it used to be sent three times.
    routeFetch({
      token: () => ({ access_token: "tok", expires_in: 7200 }),
      api: () => ({ errcode: 0 }),
    });
    wecomFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/gettoken")) return json({ access_token: "tok", expires_in: 7200 });
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });

    await expect(
      new WecomDocClient().createDoc({ agent: createAgent(), docName: "周报" }),
    ).rejects.toThrow("timeout");
    expect(apiCalls()).toHaveLength(1);
  });
});
