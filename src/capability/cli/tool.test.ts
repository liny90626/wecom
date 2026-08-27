import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { resetCredentialState } from "./credentials.js";
import {
  cliArgsForMcpCall,
  createWeComCliTool,
  createWeComCliToolFactory,
  executeWecomCli,
  prepareCliArguments,
  resetCliToolState,
  resolveCliBot,
  runCli,
} from "./tool.js";
import { resetLocateCache } from "./locate.js";

let stateDir: string;
let fakeCli: string;
const PROCESS_TEST_TIMEOUT_MS = 30_000;

function createFakeCli(): string {
  const script = path.join(stateDir, "fake-wecom-cli");
  fs.writeFileSync(
    script,
    `#!/bin/sh
set -eu
mkdir -p "$WECOM_CLI_CONFIG_DIR"
if [ "\${1:-}" = "auth" ]; then
  printf x >> "$WECOM_CLI_CONFIG_DIR/auth-count"
  printf encrypted > "$WECOM_CLI_CONFIG_DIR/credentials.enc"
  printf key > "$WECOM_CLI_CONFIG_DIR/.encryption_key"
  exit 0
fi
printf '%s' "$*" >> "$WECOM_CLI_CONFIG_DIR/last-args"
case "\${1:-}" in
  large)
    head -c 70000 /dev/zero | tr '\\0' x
    ;;
  slow)
    sleep 1
    printf '%s' '{"ok":true}'
    ;;
  retry)
    if [ ! -f "$WECOM_CLI_CONFIG_DIR/retry-seen" ]; then
      touch "$WECOM_CLI_CONFIG_DIR/retry-seen"
      printf '%s' '{"error":{"code":853004,"message":"expired"}}'
      exit 1
    fi
    printf '%s' '{"ok":"retry"}'
    ;;
  badcmd)
    printf '%s' 'unknown command' >&2
    exit 2
    ;;
  envcheck)
    printf '%s' "{\\\"base\\\":\\\"\${WECOM_CLI_BASE_URL:-}\\\",\\\"config\\\":\\\"$WECOM_CLI_CONFIG_DIR\\\"}"
    ;;
  *)
    printf '%s' '{"ok":true}'
    ;;
esac
`,
    "utf8",
  );
  fs.chmodSync(script, 0o755);
  return script;
}

function configFor(
  options: {
    botId?: string;
    secret?: string;
    cliEnv?: Record<string, string>;
  } = {},
): OpenClawConfig {
  return {
    channels: {
      wecom: {
        enabled: true,
        cli: { binPath: fakeCli, env: options.cliEnv },
        bot: {
          primaryTransport: "ws",
          ws: { botId: options.botId ?? "bot-a", secret: options.secret ?? "secret-a" },
        },
      },
    },
  } as OpenClawConfig;
}

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

afterEach(() => {
  resetCliToolState();
  resetCredentialState();
  resetLocateCache();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  delete process.env.OPENCLAW_STATE_DIR;
});

describe("wecom-cli tool", { timeout: 30_000, sequential: true }, () => {
  it("injects the isolated config directory and configured endpoint", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-tool-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    const result = await executeWecomCli(["envcheck"], {
      config: configFor({ cliEnv: { WECOM_CLI_BASE_URL: "https://test.example" } }),
    });
    const parsed = parseResult(result);
    expect(parsed.base).toBe("https://test.example");
    expect(String(parsed.config)).toContain(path.join(stateDir, "wecom-cli"));
  });

  it("reads the latest runtime config when a long-lived tool is reused", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-tool-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    let current = configFor({ botId: "bot-a", secret: "secret-a" });
    const tool = createWeComCliTool({ getConfig: () => current });
    const first = parseResult(await tool.execute("one", { args: ["envcheck"] }));
    current = configFor({ botId: "bot-b", secret: "secret-b" });
    const second = parseResult(await tool.execute("two", { args: ["envcheck"] }));
    expect(String(first.config)).toContain("bot-a-");
    expect(String(second.config)).toContain("bot-b-");
    expect(fs.readdirSync(path.join(stateDir, "wecom-cli"))).toHaveLength(2);
  });

  it("returns bounded output with an actionable truncation message", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-tool-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    const result = await executeWecomCli(["large"], { config: configFor() });
    expect(result.content[0]?.text).toContain("输出过大已截断");
    expect(result.content[0]?.text).toContain("缩小查询范围");
  });

  it("re-signs once for a credential error and then succeeds", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-tool-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    const result = await executeWecomCli(["retry"], {
      config: configFor({ botId: "retry-bot" }),
    });
    expect(parseResult(result)).toMatchObject({ ok: "retry" });
    const dirs = fs.readdirSync(path.join(stateDir, "wecom-cli"));
    expect(dirs).toHaveLength(1);
    expect(fs.readFileSync(path.join(stateDir, "wecom-cli", dirs[0], "auth-count"), "utf8")).toBe(
      "xx",
    );
  });

  it("classifies exit 2 separately from a runtime error", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-tool-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    const parsed = parseResult(await executeWecomCli(["badcmd"], { config: configFor() }));
    expect(String(parsed.error)).toContain("参数非法");
    expect(parsed.hint).toBeTruthy();
  });

  it("rejects unsafe args before resolving or spawning a binary", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-tool-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    const parsed = parseResult(
      await executeWecomCli(["doc", "WECOM_CLI_BASE_URL=https://evil.example"], {
        config: configFor(),
      }),
    );
    expect(String(parsed.error)).toContain("环境变量");
    expect(fs.existsSync(path.join(stateDir, "wecom-cli"))).toBe(false);
  });

  it("uses a shorter timeout for a directly tested process", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-tool-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    const dir = path.join(stateDir, "isolated");
    fs.mkdirSync(dir, { recursive: true });
    const result = await runCli(fakeCli, ["slow"], dir, {}, 20);
    expect(result.timedOut).toBe(true);
  });

  it("never lets reserved environment variables replace the injected directory", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-tool-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    const isolated = path.join(stateDir, "expected");
    fs.mkdirSync(isolated, { recursive: true });
    const output = await runCli(
      fakeCli,
      ["envcheck"],
      isolated,
      {
        WECOM_CLI_CONFIG_DIR: "/tmp/attacker",
        WECOM_CLI_BASE_URL: "https://allowed.example",
        PATH: "/tmp/attacker-bin",
        HOME: "/tmp/attacker-home",
      } as never,
      5_000,
    );
    const parsed = JSON.parse(output.stdout) as { config: string; base: string };
    expect(parsed.config).toBe(isolated);
    expect(parsed.base).toBe("https://allowed.example");
  });

  it("refuses implicit default selection with multiple configured accounts", () => {
    const cfg = {
      channels: {
        wecom: {
          accounts: {
            alpha: { bot: { ws: { botId: "a", secret: "sa" } } },
            beta: { bot: { ws: { botId: "b", secret: "sb" } } },
          },
        },
      },
    } as OpenClawConfig;
    expect(() => resolveCliBot(cfg)).toThrow("多个企业微信账号");
  });

  it("exposes only on the WeCom channel and accepts the tool prefix compatibility", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    const factory = createWeComCliToolFactory();
    expect(factory({ messageChannel: "telegram" } as never)).toBeNull();
    const tool = createWeComCliTool({ config: configFor() });
    expect(prepareCliArguments({ args: "wecom-cli doc get" })).toEqual({
      args: ["doc", "get"],
    });
    expect(tool.name).toBe("wecom-cli");
  });

  it("maps an MCP method to the CLI resource path without changing the payload", () => {
    expect(cliArgsForMcpCall("doc", "doc_contents_append", { content: "x" })).toEqual([
      "doc",
      "contents",
      "append",
      "--json",
      '{"content":"x"}',
    ]);
    expect(cliArgsForMcpCall("doc", "sheet_get_info", { docid: "e3_demo" })).toEqual([
      "sheet",
      "get",
      "--json",
      '{"docid":"e3_demo"}',
    ]);
    expect(cliArgsForMcpCall("doc", "smartsheet_add_records", { records: [] })).toEqual([
      "smartsheet",
      "records",
      "add",
      "--json",
      '{"records":[]}',
    ]);
  });
});
