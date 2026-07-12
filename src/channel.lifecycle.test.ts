import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import {
  type ChannelAccountSnapshot,
  type ChannelGatewayContext,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeEnv } from "./test-utils/runtime-env.js";
import { computeWecomMsgSignature, encryptWecomPlaintext } from "./crypto.js";
import { wecomPlugin } from "./channel.js";
import { handleWecomWebhookRequest } from "./monitor.js";
import { monitorState } from "./monitor/state.js";
import { setWecomRuntime } from "./runtime.js";
import type { ResolvedWecomAccount } from "./types/index.js";

function createMockRequest(params: {
  method: "GET" | "POST";
  url: string;
  body?: unknown;
}): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = params.method;
  req.url = params.url;
  if (params.method === "POST") {
    req.push(JSON.stringify(params.body ?? {}));
  }
  req.push(null);
  return req;
}

function createMockResponse(): ServerResponse & {
  _getData: () => string;
  _getStatusCode: () => number;
} {
  type MockResponse = ServerResponse & {
    _getData: () => string;
    _getStatusCode: () => number;
  };
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req) as MockResponse;
  let data = "";
  res.write = (chunk: string | Uint8Array) => {
    data += String(chunk);
    return true;
  };
  res.end = ((chunk?: string | Uint8Array) => {
    if (chunk) data += String(chunk);
    return res;
  }) as MockResponse["end"];
  res._getData = () => data;
  res._getStatusCode = () => res.statusCode;
  return res;
}

function createCtx(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  abortController: AbortController;
}): ChannelGatewayContext<ResolvedWecomAccount> & {
  statusUpdates: Array<Partial<ChannelAccountSnapshot>>;
} {
  const accountId = params.accountId ?? "default";
  const account = wecomPlugin.config.resolveAccount(
    params.cfg,
    accountId,
  ) as ResolvedWecomAccount;
  const snapshot: ChannelAccountSnapshot = {
    accountId,
    configured: true,
    enabled: true,
    running: false,
  };
  const runtime = createRuntimeEnv();
  setWecomRuntime(runtime as any);
  const statusUpdates: Array<Partial<ChannelAccountSnapshot>> = [];
  return {
    cfg: params.cfg,
    accountId,
    account,
    runtime: runtime as any,
    abortSignal: params.abortController.signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => snapshot,
    setStatus: (next) => {
      statusUpdates.push(next);
      Object.assign(snapshot, next);
    },
    statusUpdates,
  };
}

function createWebhookBotConfig(params: {
  token: string;
  encodingAESKey: string;
  receiveId?: string;
}): OpenClawConfig {
  return {
    channels: {
      wecom: {
        enabled: true,
        bot: {
          primaryTransport: "webhook",
          webhook: {
            token: params.token,
            encodingAESKey: params.encodingAESKey,
            receiveId: params.receiveId ?? "",
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function sendWecomGetVerify(params: {
  path: string;
  token: string;
  encodingAESKey: string;
  receiveId: string;
}): Promise<{ handled: boolean; status: number; body: string }> {
  const timestamp = "1700000000";
  const nonce = "nonce";
  const echostr = encryptWecomPlaintext({
    encodingAESKey: params.encodingAESKey,
    receiveId: params.receiveId,
    plaintext: "ping",
  });
  const msgSignature = computeWecomMsgSignature({
    token: params.token,
    timestamp,
    nonce,
    encrypt: echostr,
  });
  const req = createMockRequest({
    method: "GET",
    url:
      `${params.path}?msg_signature=${encodeURIComponent(msgSignature)}` +
      `&timestamp=${encodeURIComponent(timestamp)}` +
      `&nonce=${encodeURIComponent(nonce)}` +
      `&echostr=${encodeURIComponent(echostr)}`,
  });
  const res = createMockResponse();
  const handled = await handleWecomWebhookRequest(req, res);
  return {
    handled,
    status: res._getStatusCode(),
    body: res._getData(),
  };
}

describe("wecomPlugin gateway lifecycle", () => {
  it("keeps startAccount pending until abort signal", async () => {
    const token = "token";
    const encodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const cfg = createWebhookBotConfig({ token, encodingAESKey });
    const abortController = new AbortController();
    const ctx = createCtx({ cfg, abortController });

    const startPromise = wecomPlugin.gateway!.startAccount!(ctx);
    let resolved = false;
    void startPromise.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    abortController.abort();
    await startPromise;
    expect(resolved).toBe(true);
  });

  it("unregisters webhook targets after abort", async () => {
    const token = "token";
    const encodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const receiveId = "";
    const cfg = createWebhookBotConfig({ token, encodingAESKey, receiveId });
    const abortController = new AbortController();
    const ctx = createCtx({ cfg, abortController });

    const startPromise = wecomPlugin.gateway!.startAccount!(ctx);
    await Promise.resolve();

    const activeLegacyRoute = await sendWecomGetVerify({
      path: "/wecom/bot",
      token,
      encodingAESKey,
      receiveId,
    });
    expect(activeLegacyRoute.handled).toBe(true);
    expect(activeLegacyRoute.status).toBe(200);
    expect(activeLegacyRoute.body).toBe("ping");

    const activePluginRoute = await sendWecomGetVerify({
      path: "/plugins/wecom/bot",
      token,
      encodingAESKey,
      receiveId,
    });
    expect(activePluginRoute.handled).toBe(true);
    expect(activePluginRoute.status).toBe(200);
    expect(activePluginRoute.body).toBe("ping");

    abortController.abort();
    await startPromise;

    const inactiveLegacyRoute = await sendWecomGetVerify({
      path: "/wecom/bot",
      token,
      encodingAESKey,
      receiveId,
    });
    expect(inactiveLegacyRoute.handled).toBe(false);

    const inactivePluginRoute = await sendWecomGetVerify({
      path: "/plugins/wecom/bot",
      token,
      encodingAESKey,
      receiveId,
    });
    expect(inactivePluginRoute.handled).toBe(false);
  });

  it("settles pending webhook batches for the account before reload shutdown completes", async () => {
    const token = "token";
    const encodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const cfg = createWebhookBotConfig({ token, encodingAESKey });
    const abortController = new AbortController();
    const ctx = createCtx({ cfg, abortController });
    const cancelPending = vi.spyOn(monitorState.streamStore, "cancelPendingForAccount");

    const startPromise = wecomPlugin.gateway!.startAccount!(ctx);
    await Promise.resolve();
    abortController.abort();
    await startPromise;

    expect(cancelPending).toHaveBeenCalledWith(
      "default",
      expect.stringContaining("stopped"),
    );
    cancelPending.mockRestore();
  });

  it("does not enqueue an in-flight webhook request after reload retires its target", async () => {
    const token = "token";
    const encodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const timestamp = "1700000000";
    const nonce = "nonce";
    const cfg = createWebhookBotConfig({ token, encodingAESKey });
    const abortController = new AbortController();
    const ctx = createCtx({ cfg, abortController });
    const startPromise = wecomPlugin.gateway!.startAccount!(ctx);
    await Promise.resolve();

    const plain = JSON.stringify({
      msgid: "MSG-RELOAD-IN-FLIGHT",
      aibotid: "BOT",
      chattype: "single",
      from: { userid: "alice" },
      msgtype: "text",
      text: { content: "不要在旧 target 入队" },
    });
    const encrypt = encryptWecomPlaintext({
      encodingAESKey,
      receiveId: "",
      plaintext: plain,
    });
    const signature = computeWecomMsgSignature({
      token,
      timestamp,
      nonce,
      encrypt,
    });
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url =
      `/plugins/wecom/bot?msg_signature=${encodeURIComponent(signature)}` +
      `&timestamp=${timestamp}&nonce=${nonce}`;
    const res = createMockResponse();
    const addPending = vi.spyOn(monitorState.streamStore, "addPendingMessage");

    try {
      const handledPromise = handleWecomWebhookRequest(req, res);
      await Promise.resolve();
      abortController.abort();
      await startPromise;

      req.push(JSON.stringify({ encrypt }));
      req.push(null);
      await expect(handledPromise).resolves.toBe(true);

      expect(res._getStatusCode()).toBe(503);
      expect(res._getData()).toContain("服务正在重载");
      expect(addPending).not.toHaveBeenCalled();
    } finally {
      addPending.mockRestore();
      if (!abortController.signal.aborted) {
        abortController.abort();
        await startPromise;
      }
    }
  });

  it("rejects startup when matrix account credentials conflict", async () => {
    const cfg = {
      channels: {
        wecom: {
          enabled: true,
          accounts: {
            "acct-a": {
              enabled: true,
              bot: {
                token: "token-shared",
                encodingAESKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
              },
            },
            "acct-b": {
              enabled: true,
              bot: {
                token: "token-shared",
                encodingAESKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const abortController = new AbortController();
    const ctx = createCtx({ cfg, accountId: "acct-b", abortController });

    await expect(wecomPlugin.gateway!.startAccount!(ctx)).rejects.toThrow(
      /Duplicate WeCom bot token/i,
    );
  });
});
