import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cliConfigDirFor,
  ensureSynced,
  isCliAuthorized,
  resetCredentialState,
} from "./credentials.js";

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
  if [ "\${4:-}" = "bad-bot" ]; then
    printf '%s' '{"error":{"code":853000,"message":"invalid bot secret"}}'
    exit 1
  fi
  printf encrypted > "$WECOM_CLI_CONFIG_DIR/credentials.enc"
  printf key > "$WECOM_CLI_CONFIG_DIR/.encryption_key"
  exit 0
fi
exit 0
`,
    "utf8",
  );
  fs.chmodSync(script, 0o755);
  return script;
}

afterEach(() => {
  resetCredentialState();
  vi.restoreAllMocks();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  delete process.env.OPENCLAW_STATE_DIR;
});

describe("wecom-cli credential isolation", { timeout: 30_000, sequential: true }, () => {
  it("derives isolated directories from bot and secret and keeps them private", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const first = cliConfigDirFor("bot.one", "secret-a");
    const second = cliConfigDirFor("bot.one", "secret-b");
    const otherBot = cliConfigDirFor("other", "secret-a");
    expect(first).not.toBe(second);
    expect(first).not.toBe(otherBot);
    expect(path.basename(first)).toMatch(/^bot_one-[0-9a-f]{8}$/);
  });

  it("spawns auth once and short-circuits when both credential files exist", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    const first = await ensureSynced({ binPath: fakeCli, botId: "bot-a", secret: "secret-a" });
    const second = await ensureSynced({ binPath: fakeCli, botId: "bot-a", secret: "secret-a" });
    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(first, "auth-count"), "utf8")).toBe("x");
    expect(isCliAuthorized(first)).toBe(true);
    expect(fs.statSync(first).mode & 0o777).toBe(0o700);
  });

  it("deduplicates concurrent auth for the same directory", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureSynced({ binPath: fakeCli, botId: "bot-a", secret: "secret-a" }),
      ),
    );
    expect(new Set(results).size).toBe(1);
    expect(fs.readFileSync(path.join(results[0], "auth-count"), "utf8")).toBe("x");
  });

  it("does not reuse a failed auth as a successful login", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    await expect(
      ensureSynced({ binPath: fakeCli, botId: "bad-bot", secret: "secret-a" }),
    ).rejects.toMatchObject({ name: "CliAuthError", errcode: 853000 });
    const dir = cliConfigDirFor("bad-bot", "secret-a");
    expect(isCliAuthorized(dir)).toBe(false);
  });

  it("applies a five-minute cooldown after a forced re-sign", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    await ensureSynced({ binPath: fakeCli, botId: "bot-a", secret: "secret-a" });
    await ensureSynced({ binPath: fakeCli, botId: "bot-a", secret: "secret-a", force: true });
    await expect(
      ensureSynced({ binPath: fakeCli, botId: "bot-a", secret: "secret-a", force: true }),
    ).rejects.toThrow("45009");
    const dir = cliConfigDirFor("bot-a", "secret-a");
    expect(fs.readFileSync(path.join(dir, "auth-count"), "utf8")).toBe("xx");
  });

  it("cleans only matching old secret directories after successful auth", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    const oldDir = cliConfigDirFor("bot-a", "old-secret");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "credentials.enc"), "old");
    const currentDir = await ensureSynced({
      binPath: fakeCli,
      botId: "bot-a",
      secret: "new-secret",
    });
    expect(fs.existsSync(currentDir)).toBe(true);
    expect(fs.existsSync(oldDir)).toBe(false);
  });

  it("never prints the configured secret while reporting auth", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    fakeCli = createFakeCli();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await ensureSynced({ binPath: fakeCli, botId: "bot-a", secret: "TOP-SECRET-VALUE" });
    const text = log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(text).not.toContain("TOP-SECRET-VALUE");
    expect(text).toContain("***");
  });
});
