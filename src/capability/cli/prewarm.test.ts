import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { cliConfigDirFor, resetCredentialState } from "./credentials.js";
import { prewarmWecomCliCredentials } from "./prewarm.js";
import { resetLocateCache } from "./locate.js";

let stateDir: string;
let fakeCli: string;
const PROCESS_TEST_TIMEOUT_MS = 30_000;

function makeCli(): string {
  fakeCli = path.join(stateDir, "fake-wecom-cli");
  fs.writeFileSync(
    fakeCli,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "auth" ]; then
  mkdir -p "$WECOM_CLI_CONFIG_DIR"
  printf x > "$WECOM_CLI_CONFIG_DIR/credentials.enc"
  printf x > "$WECOM_CLI_CONFIG_DIR/.encryption_key"
fi
`,
  );
  fs.chmodSync(fakeCli, 0o755);
  return fakeCli;
}

afterEach(() => {
  resetCredentialState();
  resetLocateCache();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  delete process.env.OPENCLAW_STATE_DIR;
});

describe("wecom-cli startup prewarm", { timeout: 30_000, sequential: true }, () => {
  it("warms enabled Bot WS accounts before the first business call", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-prewarm-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const cfg = {
      channels: {
        wecom: {
          cli: { binPath: makeCli() },
          accounts: {
            primary: {
              enabled: true,
              bot: { ws: { botId: "bot-primary", secret: "secret-primary" } },
            },
          },
        },
      },
    } as OpenClawConfig;
    const info: string[] = [];
    await prewarmWecomCliCredentials(cfg, { info: (message) => info.push(message) });
    const dir = cliConfigDirFor("bot-primary", "secret-primary");
    expect(fs.existsSync(path.join(dir, "credentials.enc"))).toBe(true);
    expect(info.join("\n")).toContain("预热完成");
  });

  it("reports a missing binary without throwing or changing existing channel state", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-prewarm-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const warnings: string[] = [];
    await expect(
      prewarmWecomCliCredentials(
        {
          channels: {
            wecom: {
              cli: { binPath: path.join(stateDir, "missing") },
              bot: { ws: { botId: "bot", secret: "secret" } },
            },
          },
        } as OpenClawConfig,
        { warn: (message) => warnings.push(message) },
      ),
    ).resolves.toBeUndefined();
    expect(warnings.join("\n")).toContain("未找到");
  });
});
