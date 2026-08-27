import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  queue: [] as unknown[],
  connected: true,
  replyCommand: vi.fn(),
  source: {
    source: "bot-ws",
    requesterUserId: "ZhangSan",
    chatId: "wrABCDefGH",
    peerKind: "direct",
  } as Record<string, unknown>,
}));

vi.mock("../../runtime.js", () => ({
  getWecomRuntime: () => ({ config: { loadConfig: () => state.cfg } }),
  getBotWsPushHandle: () => ({
    isConnected: () => state.connected,
    replyCommand: state.replyCommand,
  }),
}));

vi.mock("../../config/accounts.js", () => ({
  resolveWecomAccount: ({ cfg, accountId }: { cfg: any; accountId?: string }) => {
    const wecom = cfg.channels?.wecom ?? {};
    const account = accountId ? wecom.accounts?.[accountId] : undefined;
    const source = account ?? wecom;
    const ws = source.bot?.ws;
    return {
      accountId: accountId ?? "default",
      enabled: true,
      config: source,
      bot: ws
        ? { ws, botId: ws.botId, secret: ws.secret, config: source.bot ?? {} }
        : { config: source.bot ?? {} },
    };
  },
  listWecomAccountIds: (cfg: any) => Object.keys(cfg.channels?.wecom?.accounts ?? {}).sort(),
}));

vi.mock("../../runtime/source-registry.js", () => ({
  resolveWecomSourceSnapshot: () => state.source,
}));

vi.mock("@wecom/aibot-node-sdk", () => ({
  generateReqId: (prefix: string) => `${prefix}-1`,
}));

vi.mock("undici", () => ({
  fetch: vi.fn(async (_url: string, init: { body: string }) => {
    const next = state.queue.shift();
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: "id", result: next }),
      requestBody: JSON.parse(init.body),
    };
  }),
}));

import { cliConfigDirFor } from "../cli/credentials.js";
import { clearWecomMcpAccountCache } from "./transport.js";
import { createWeComMcpToolFactory } from "./tool.js";

let stateDir: string;
let fakeCli: string;
const PROCESS_TEST_TIMEOUT_MS = 30_000;

function makeCli(): string {
  fakeCli = path.join(stateDir, "fake-wecom-cli");
  fs.writeFileSync(
    fakeCli,
    `#!/bin/sh
set -eu
mkdir -p "$WECOM_CLI_CONFIG_DIR"
if [ "\${1:-}" = "auth" ]; then
  printf x > "$WECOM_CLI_CONFIG_DIR/credentials.enc"
  printf x > "$WECOM_CLI_CONFIG_DIR/.encryption_key"
  exit 0
fi
printf x > "$WECOM_CLI_CONFIG_DIR/cli-called"
printf '%s' "$*" > "$WECOM_CLI_CONFIG_DIR/last-args"
printf '%s' '{"ok":"cli","via":"child"}'
`,
  );
  fs.chmodSync(fakeCli, 0o755);
  return fakeCli;
}

function makeConfig(): Record<string, unknown> {
  return {
    channels: {
      wecom: {
        cli: { binPath: fakeCli },
        accounts: {
          account_a: {
            enabled: true,
            bot: { ws: { botId: "bot-a", secret: "secret-a" } },
          },
        },
      },
    },
  };
}

async function runCall(
  category = "doc",
  method = "doc_create",
): Promise<Record<string, unknown>> {
  const tool = createWeComMcpToolFactory()({
    messageChannel: "wecom",
    accountId: "account_a",
    sessionKey: "session-a",
    sessionId: "session-a",
    requesterSenderId: "ZhangSan",
  } as never);
  if (!tool) throw new Error("MCP tool unavailable");
  const result = (await tool.execute("call", {
    action: "call",
    category,
    method,
    args: "{}",
  })) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-mcp-fallback-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  makeCli();
  state.cfg = makeConfig();
  const prewarmedDir = cliConfigDirFor("bot-a", "secret-a");
  fs.mkdirSync(prewarmedDir, { recursive: true });
  fs.writeFileSync(path.join(prewarmedDir, "credentials.enc"), "x");
  fs.writeFileSync(path.join(prewarmedDir, ".encryption_key"), "x");
  state.queue.length = 0;
  state.connected = true;
  state.source = {
    source: "bot-ws",
    requesterUserId: "ZhangSan",
    chatId: "wrABCDefGH",
    peerKind: "direct",
  };
  state.replyCommand.mockReset();
  state.replyCommand.mockResolvedValue({ errcode: 0, body: { url: "https://mcp.test/doc" } });
  clearWecomMcpAccountCache("account_a");
});

afterEach(() => {
  clearWecomMcpAccountCache("account_a");
  vi.restoreAllMocks();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  delete process.env.OPENCLAW_STATE_DIR;
});

describe("MCP narrow CLI fallback", { timeout: 30_000, sequential: true }, () => {
  it("falls back on explicit 851003 and marks the returned plane", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    state.queue.push(
      { protocolVersion: "2025-03-26" },
      {
        content: [{ type: "text", text: JSON.stringify({ errcode: 851003, errmsg: "no authority" }) }],
      },
    );
    const result = await runCall();
    expect(result).toMatchObject({ ok: "cli", via: "cli-fallback:851003" });
  });

  it("executes MCP category aliases and doc subservices through the correct CLI path", async () => {
    const cases = [
      ["msg", "message_aibot_send", "message aibot send --json {}"],
      ["schedule", "calendar_schedules_create", "calendar schedules create --json {}"],
      ["doc", "sheet_get", "sheet get --json {}"],
    ] as const;
    const configDir = cliConfigDirFor("bot-a", "secret-a");

    for (const [category, method, expectedArgs] of cases) {
      clearWecomMcpAccountCache("account_a");
      state.queue.length = 0;
      state.queue.push(
        { protocolVersion: "2025-03-26" },
        {
          content: [
            { type: "text", text: JSON.stringify({ errcode: 851003, errmsg: "no authority" }) },
          ],
        },
      );
      const result = await runCall(category, method);
      expect(result).toMatchObject({ ok: "cli", via: "cli-fallback:851003" });
      expect(fs.readFileSync(path.join(configDir, "last-args"), "utf8")).toBe(expectedArgs);
    }
  }, PROCESS_TEST_TIMEOUT_MS);

  it("falls back when MCP endpoint authorization is explicitly false", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    state.replyCommand.mockResolvedValue({
      errcode: 0,
      body: { url: "https://mcp.test/doc", is_authed: false },
    });
    state.queue.push({ protocolVersion: "2025-03-26" });
    const result = await runCall();
    expect(result).toMatchObject({ ok: "cli", via: "cli-fallback:not-authed" });
  });

  it("does not perform auth inline when startup prewarm has not completed", async () => {
    const prewarmedDir = cliConfigDirFor("bot-a", "secret-a");
    fs.rmSync(prewarmedDir, { recursive: true, force: true });
    state.queue.push(
      { protocolVersion: "2025-03-26" },
      {
        content: [{ type: "text", text: JSON.stringify({ errcode: 851003, errmsg: "no authority" }) }],
      },
    );
    const result = await runCall();
    expect(String(result.error)).toContain("不会在请求路径中触发授权");
    expect(String(result.via)).toBe("cli-fallback:851003");
    expect(fs.existsSync(path.join(stateDir, "wecom-cli"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "wecom-cli", "bot-a-c8ef9ccd", "cli-called"))).toBe(
      false,
    );
  }, PROCESS_TEST_TIMEOUT_MS);

  it("does not fall back for a document authorization error", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    state.queue.push(
      { protocolVersion: "2025-03-26" },
      {
        content: [{ type: "text", text: JSON.stringify({ errcode: 851013, errmsg: "not authorized" }) }],
      },
    );
    const result = await runCall();
    expect(JSON.stringify(result)).toContain("851013");
    expect(JSON.stringify(result)).not.toContain("cli-fallback");
  });

  it("does not fall back for 851014 or 45009", async () => {
    for (const [category, errcode] of [
      ["doc", 851014],
      ["contact", 45009],
    ] as const) {
      clearWecomMcpAccountCache("account_a");
      state.queue.length = 0;
      state.queue.push(
        { protocolVersion: "2025-03-26" },
        { content: [{ type: "text", text: JSON.stringify({ errcode, errmsg: "blocked" }) }] },
      );
      const tool = createWeComMcpToolFactory()({
        messageChannel: "wecom",
        accountId: "account_a",
        sessionKey: `session-${category}`,
        sessionId: `session-${category}`,
        requesterSenderId: "ZhangSan",
      } as never);
      if (!tool) throw new Error("MCP tool unavailable");
      const result = (await tool.execute("call", {
        action: "call",
        category,
        method: "doc_create",
        args: "{}",
      })) as { content: Array<{ text: string }> };
      expect(result.content[0]?.text).toContain(String(errcode));
      expect(fs.existsSync(path.join(stateDir, "wecom-cli", "bot-a-c8ef9ccd", "cli-called"))).toBe(
        false,
      );
    }
  }, PROCESS_TEST_TIMEOUT_MS);

  it("does not replay a business write after a transport failure", async () => {
    state.cfg = {
      ...makeConfig(),
      channels: {
        wecom: {
          ...(makeConfig().channels as any).wecom,
          accounts: {
            account_a: {
              enabled: true,
              cli: { binPath: fakeCli },
              bot: {
                ws: { botId: "bot-a", secret: "secret-a" },
                mcpServers: { doc: "https://mcp.test/doc" },
              },
            },
          },
        },
      },
    };
    const { fetch } = await import("undici");
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("connection reset"));
    state.queue.length = 0;
    const result = await runCall();
    expect(JSON.stringify(result)).toContain("connection reset");
    expect(fs.existsSync(path.join(stateDir, "wecom-cli", "bot-a-c8ef9ccd", "cli-called"))).toBe(
      false,
    );
  }, PROCESS_TEST_TIMEOUT_MS);

  it("does not reinterpret a config transport failure as a fallback-eligible error", async () => {
    state.cfg = makeConfig();
    state.replyCommand.mockRejectedValueOnce(new Error("config connection reset"));
    state.queue.length = 0;
    const result = await runCall();
    expect(JSON.stringify(result)).toContain("config connection reset");
    expect(JSON.stringify(result)).not.toContain("cli-fallback");
    expect(
      fs.existsSync(path.join(stateDir, "wecom-cli", "bot-a-c8ef9ccd", "cli-called")),
    ).toBe(false);
  }, PROCESS_TEST_TIMEOUT_MS);
});
