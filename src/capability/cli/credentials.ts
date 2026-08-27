/**
 * OpenClaw-side credential policy for wecom-cli.
 *
 * The credential format and encryption remain entirely owned by the CLI. This
 * module only chooses an isolated directory, avoids redundant auth requests,
 * serializes keyring access, and limits forced re-sign attempts.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CLI_AUTH_TIMEOUT_MS,
  filterCliEnv,
  CLI_KILL_FORCE_WAIT_MS,
  CLI_KILL_GRACE_MS,
  CLI_LOG,
  CLI_MAX_OUTPUT_BYTES,
  CLI_RESIGN_COOLDOWN_MS,
} from "./const.js";
import { spawn } from "./process-launcher.js";
import { BoundedOutputCollector } from "./process-output.js";
import { resolveCliStateDir } from "./state-dir.js";

export class CliAuthError extends Error {
  constructor(
    message: string,
    public readonly errcode?: number,
  ) {
    super(message);
    this.name = "CliAuthError";
  }
}

export type CliEnvOverrides = Partial<
  Record<
    "WECOM_CLI_BASE_URL" | "WECOM_CLI_AUTH_ENDPOINT" | "WECOM_CLI_ADDITIONAL_HEADERS",
    string
  >
>;

const FINGERPRINT_LEN = 8;
const DIR_SHAPE = new RegExp(`^(.+)-([0-9a-f]{${FINGERPRINT_LEN}})$`);

function cliStateRoot(): string {
  return path.join(resolveCliStateDir(), "wecom-cli");
}

function safeBotId(botId: string): string {
  return botId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function credentialsPath(dir: string): string {
  return path.join(dir, "credentials.enc");
}

function keyPath(dir: string): string {
  return path.join(dir, ".encryption_key");
}

export function cliConfigDirFor(botId: string, secret: string): string {
  const fingerprint = createHash("sha256")
    .update(`${botId}:${secret}`, "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_LEN);
  return path.join(cliStateRoot(), `${safeBotId(botId)}-${fingerprint}`);
}

export function isCliAuthorized(dir: string): boolean {
  return fs.existsSync(credentialsPath(dir)) && fs.existsSync(keyPath(dir));
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function cleanupSiblings(botId: string, currentDir: string): void {
  const root = cliStateRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  const prefix = safeBotId(botId);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = DIR_SHAPE.exec(entry.name);
    if (!match || match[1] !== prefix) continue;
    const sibling = path.join(root, entry.name);
    if (sibling === currentDir) continue;
    try {
      fs.rmSync(sibling, { recursive: true, force: true });
      console.log(`${CLI_LOG} 已清理旧凭据目录 ${entry.name}`);
    } catch (error) {
      console.warn(
        `${CLI_LOG} 清理旧凭据目录失败（不影响本次调用）${entry.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

type AuthProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
};

function spawnAuthInit(
  binPath: string,
  botId: string,
  secret: string,
  dir: string,
  env: CliEnvOverrides,
): Promise<AuthProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(
      binPath,
      ["auth", "init", "--bot-id", botId, "--secret", secret],
      {
        shell: false,
        cwd: resolveCliStateDir(),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...(process.platform === "win32"
            ? {
                USERPROFILE: process.env.USERPROFILE ?? "",
                SystemRoot: process.env.SystemRoot ?? "",
              }
            : {}),
          WECOM_CLI_CONFIG_DIR: dir,
          WECOM_CLI_LOG_LEVEL: "warn",
          ...filterCliEnv(env),
        },
        // stdin=ignore is intentional: an accidental interactive code path
        // receives EOF instead of holding the gateway open.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout = new BoundedOutputCollector(CLI_MAX_OUTPUT_BYTES, "head");
    const stderr = new BoundedOutputCollector(CLI_MAX_OUTPUT_BYTES, "tail");
    let timedOut = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceWaitTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout>;

    const clearTimers = () => {
      clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (forceWaitTimer) clearTimeout(forceWaitTimer);
    };
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        status,
        stdout: stdout.result().text,
        stderr: stderr.result().text,
        ms: Date.now() - started,
        timedOut,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    killTimer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      graceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        forceWaitTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(child.exitCode);
        }, CLI_KILL_FORCE_WAIT_MS);
      }, CLI_KILL_GRACE_MS);
    }, CLI_AUTH_TIMEOUT_MS);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.on("close", (status) => finish(status));
  });
}

function extractErrcode(stdout: string): number | null {
  try {
    const parsed = JSON.parse(stdout) as {
      error?: { code?: unknown };
      errcode?: unknown;
    };
    const code = parsed.error?.code ?? parsed.errcode;
    if (typeof code === "number") return code;
    if (typeof code === "string" && /^-?\d+$/.test(code)) return Number(code);
    return null;
  } catch {
    return null;
  }
}

function extractMessage(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as {
      error?: { message?: unknown };
      errmsg?: unknown;
    };
    const message = parsed.error?.message ?? parsed.errmsg;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

let authChain: Promise<unknown> = Promise.resolve();
function serializeAuth<T>(task: () => Promise<T>): Promise<T> {
  const next = authChain.then(task, task);
  authChain = next.catch(() => undefined);
  return next;
}

async function runAuthInit(
  binPath: string,
  botId: string,
  secret: string,
  dir: string,
  env: CliEnvOverrides,
): Promise<void> {
  ensurePrivateDirectory(dir);
  const redact = (value: string): string => (secret ? value.split(secret).join("***") : value);
  const shortBot = `${botId.slice(0, 10)}…`;
  console.log(`${CLI_LOG} 授权中 auth init --bot-id ${shortBot} --secret *** → ${path.basename(dir)}`);

  const output = await spawnAuthInit(binPath, botId, secret, dir, env);
  if (output.timedOut) {
    throw new CliAuthError(
      `企业微信授权超时（${CLI_AUTH_TIMEOUT_MS / 1000}s）。常见原因：网络不可达，或系统钥匙串弹出了授权确认而无人响应。`,
    );
  }
  if (output.status === 2) {
    throw new CliAuthError(
      "当前 wecom-cli 不支持非交互授权（缺少 --bot-id/--secret）。插件已锁定支持该能力的版本，请检查 channels.wecom.cli.binPath 是否指向了旧二进制或全局安装的 cli。",
    );
  }
  if (output.status !== 0) {
    const code = extractErrcode(output.stdout) ?? undefined;
    const detail =
      extractMessage(output.stdout) ??
      (output.stdout.trim() || output.stderr.trim() || `exit ${output.status}`).slice(0, 500);
    throw new CliAuthError(
      `企业微信授权失败：${redact(detail)}${code != null ? `（errcode=${code}）` : ""}。请检查 openclaw 配置 channels.wecom 中的 botId / secret 是否正确。`,
      code,
    );
  }
  if (!isCliAuthorized(dir)) {
    throw new CliAuthError(
      `wecom-cli 授权返回成功，但 ${path.basename(dir)} 下未生成凭据文件。可能是 cli 版本行为变更，请检查插件依赖的 @wecom/cli 版本。`,
    );
  }
  console.log(`${CLI_LOG} 授权成功 botId=${shortBot} (${output.ms}ms)`);
  cleanupSiblings(botId, dir);
}

const inflight = new Map<string, Promise<string>>();
const lastResignAttempt = new Map<string, number>();
const lastResignSucceeded = new Map<string, number>();

export async function ensureSynced(params: {
  binPath: string;
  botId: string;
  secret: string;
  env?: CliEnvOverrides;
  force?: boolean;
  allowAuth?: boolean;
}): Promise<string> {
  const { binPath, botId, secret, env = {}, force = false, allowAuth = true } = params;
  if (!botId.trim() || !secret.trim()) {
    throw new CliAuthError("当前企业微信账号未配置 botId / secret，请检查 openclaw 配置 channels.wecom");
  }
  const dir = cliConfigDirFor(botId, secret);
  if (!force && isCliAuthorized(dir)) return dir;

  if (!allowAuth) {
    throw new CliAuthError(
      "wecom-cli 凭据尚未完成启动预热，当前 MCP 兜底不会在请求路径中触发授权；请等待 Gateway 预热完成后重试。",
    );
  }

  const existing = inflight.get(dir);
  if (existing) return existing;

  const task = serializeAuth(async () => {
    if (!force && isCliAuthorized(dir)) return dir;

    let attemptAt: number | undefined;
    if (force) {
      const last = lastResignAttempt.get(dir) ?? 0;
      const elapsed = Date.now() - last;
      if (elapsed < CLI_RESIGN_COOLDOWN_MS) {
        const waitSec = Math.ceil((CLI_RESIGN_COOLDOWN_MS - elapsed) / 1000);
        const succeeded = (lastResignSucceeded.get(dir) ?? 0) >= last;
        throw new CliAuthError(
          `${succeeded ? "凭据刚刚重新签发成功但仍然不可用" : "凭据刚刚尝试重新签发但未成功"}，${waitSec} 秒内不再重试，以避免触发企业微信换取凭据的频率限制（45009）。请检查 openclaw 配置 channels.wecom 中的 botId / secret 是否正确。`,
        );
      }
      attemptAt = Date.now();
      lastResignAttempt.set(dir, attemptAt);
    }

    try {
      await runAuthInit(binPath, botId, secret, dir, env);
      if (force) lastResignSucceeded.set(dir, Date.now());
      return dir;
    } catch (error) {
      if (force) {
        console.warn(
          `${CLI_LOG} 强制重签失败，保留本次尝试的冷却保护 (attemptAt=${attemptAt ?? "unknown"}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }).finally(() => {
    if (inflight.get(dir) === task) inflight.delete(dir);
  });
  inflight.set(dir, task);
  return task;
}

export function resetCredentialState(): void {
  inflight.clear();
  lastResignAttempt.clear();
  lastResignSucceeded.clear();
  authChain = Promise.resolve();
}
