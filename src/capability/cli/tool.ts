/** Wrap the plugin-private wecom-cli binary as an OpenClaw tool. */
import { spawn } from "./process-launcher.js";
import type {
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import * as path from "node:path";

import { listWecomAccountIds, resolveWecomAccount } from "../../config/accounts.js";
import { resolveWecomCliConfig } from "../../config/cli.js";
import { getWecomRuntime } from "../../runtime.js";
import type { WecomCliEnv } from "../../types/config.js";
import {
  CLI_ENV_PASSTHROUGH,
  filterCliEnv,
  CLI_FALLBACK_TIMEOUT_MS,
  CLI_KILL_FORCE_WAIT_MS,
  CLI_KILL_GRACE_MS,
  CLI_LOG,
  CLI_MAX_OUTPUT_BYTES,
  CLI_RESIGN_CODES,
  CLI_TIMEOUT_MS,
  CLI_TOOL_NAME,
} from "./const.js";
import { CliArgvError, normalizeArgs } from "./argv.js";
import { CliAuthError, ensureSynced } from "./credentials.js";
import { locateCliBinary } from "./locate.js";
import { BoundedOutputCollector } from "./process-output.js";
import { resolveCliStateDir } from "./state-dir.js";

type CliToolResult = {
  content: [{ type: "text"; text: string }];
  details: unknown;
};

export type CliExecutionResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stdoutTruncated: boolean;
  ms: number;
  timedOut: boolean;
};

const DESCRIPTION = [
  "执行企业微信命令行（wecom-cli），用于访问通讯录、文档、会议、日程、待办、智能表格等企业微信能力。",
  "",
  "参数 `args` 是命令行中 `wecom-cli ` 之后的字符串数组。",
  "例如：[\"contact\",\"users\",\"search\",\"--json\",\"{\\\"keywords\\\":[\\\"张三\\\"]}\"]",
  "参数值本身含引号、空格或特殊字符时，仍作为一个完整数组元素传入。",
  "",
  "重要约束：",
  "  - 企业微信业务命令必须通过本 tool 执行；禁止使用 exec、bash、shell、npx 或 PATH 上的全局 wecom-cli。",
  "  - 本 tool 内部会按当前会话账号注入隔离凭据目录；不要传 WECOM_CLI_* 环境变量、--config-dir 或 --home。",
  "  - 本 tool 失败时不要降级到 exec，也不要手动执行 auth init；应报告工具权限或 channels.wecom 配置问题。",
  "  - 涉及本地文件的参数请使用绝对路径；需要参数结构时可在命令末尾加 --schema 或 --doc。",
].join("\n");

function textResult(data: unknown): CliToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }], details: data };
}

function errorResult(message: string, extra?: Record<string, unknown>): CliToolResult {
  return textResult({ error: message, ...extra });
}

function normalizeConfig(value: unknown): OpenClawConfig | undefined {
  return value && typeof value === "object" ? (value as OpenClawConfig) : undefined;
}

function loadConfig(config?: OpenClawConfig): OpenClawConfig {
  if (config) return config;
  return getWecomRuntime().config.loadConfig();
}

type ResolvedCliBot = {
  accountId: string;
  botId: string;
  secret: string;
  env: WecomCliEnv;
};

/**
 * Resolve the account without inheriting a default in a multi-account session.
 * A missing context must fail closed because choosing another enterprise is a
 * data-isolation failure, not a recoverable configuration inconvenience.
 */
export function resolveCliBot(
  config: OpenClawConfig,
  accountId?: string | null,
): ResolvedCliBot {
  const ids = listWecomAccountIds(config);
  const explicit = accountId?.trim();
  if (
    ids.length > 1 &&
    (!explicit || (explicit === "default" && !ids.includes("default")))
  ) {
    throw new CliAuthError(
      "当前会话缺少账号上下文（agentAccountId），而配置中存在多个企业微信账号。为避免误用其他企业的凭据，本次调用已被拒绝。",
    );
  }

  const account = resolveWecomAccount({ cfg: config, accountId: explicit || undefined });
  const botId = account.bot?.ws?.botId?.trim() || account.bot?.botId?.trim() || "";
  const secret = account.bot?.ws?.secret?.trim() || account.bot?.secret?.trim() || "";
  if (!botId || !secret) {
    throw new CliAuthError(
      `企业微信账号 "${account.accountId}" 未配置 bot.ws.botId / bot.ws.secret，请检查 channels.wecom 配置。`,
    );
  }

  const cliConfig = resolveWecomCliConfig(config, account.accountId);
  const env: WecomCliEnv = {};
  for (const key of CLI_ENV_PASSTHROUGH) {
    const value = cliConfig.env?.[key];
    if (typeof value === "string" && value.trim()) env[key] = value.trim();
  }
  return { accountId: account.accountId, botId, secret, env };
}

export function prepareCliArguments(params: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const value = params as { args?: unknown };
  if (typeof value.args !== "string") return params;
  return { ...value, args: normalizeArgs(value.args) };
}

const queues = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(key, next.catch(() => undefined));
  return next;
}

/** Spawn with bounded output and a deterministic TERM/KILL timeout ladder. */
export function runCli(
  binPath: string,
  argv: string[],
  configDir: string,
  env: WecomCliEnv,
  timeoutMs = CLI_TIMEOUT_MS,
): Promise<CliExecutionResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(binPath, argv, {
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
        WECOM_CLI_CONFIG_DIR: configDir,
        WECOM_CLI_LOG_LEVEL: "warn",
        ...filterCliEnv(env),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      const stdoutResult = stdout.result();
      resolve({
        status,
        stdout: stdoutResult.text,
        stderr: stderr.result().text,
        stdoutBytes: stdoutResult.originalBytes,
        stdoutTruncated: stdoutResult.truncated,
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
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.on("close", (status) => finish(status));
  });
}

function parseErrorPayload(stdout: string):
  | { code?: number; message?: string; endpoint?: string; status?: number }
  | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      error?: { code?: unknown; message?: unknown; endpoint?: unknown; status?: unknown };
    };
    if (!parsed.error || typeof parsed.error !== "object") return undefined;
    return {
      ...(typeof parsed.error.code === "number"
        ? { code: parsed.error.code }
        : typeof parsed.error.code === "string" && /^-?\d+$/.test(parsed.error.code)
          ? { code: Number(parsed.error.code) }
          : {}),
      ...(typeof parsed.error.message === "string" ? { message: parsed.error.message } : {}),
      ...(typeof parsed.error.endpoint === "string" ? { endpoint: parsed.error.endpoint } : {}),
      ...(typeof parsed.error.status === "number" ? { status: parsed.error.status } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseErrcode(stdout: string): number | undefined {
  try {
    const parsed = JSON.parse(stdout) as { errcode?: unknown };
    if (typeof parsed.errcode === "number") return parsed.errcode;
    if (typeof parsed.errcode === "string" && /^-?\d+$/.test(parsed.errcode)) {
      return Number(parsed.errcode);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseErrmsg(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { errmsg?: unknown };
    return typeof parsed.errmsg === "string" ? parsed.errmsg : undefined;
  } catch {
    return undefined;
  }
}

function rewriteMessage(message: string): string {
  if (/auth\s+init/i.test(message)) {
    return "企业微信凭据不可用。请检查 openclaw 配置 channels.wecom 中的 botId / secret（请勿手动执行 wecom-cli auth init，凭据由插件统一管理）。";
  }
  return message;
}

function redactSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join("***") : value;
}

function redactEndpoint(value: string, secret: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return redactSecret(value, secret);
  }
}

function resolveBinPath(config: OpenClawConfig, accountId: string): { binPath: string; source: string } {
  const configured = resolveWecomCliConfig(config, accountId).binPath;
  const located = locateCliBinary(configured);
  if (located.ok) return { binPath: located.binPath, source: located.source };
  throw new CliAuthError(
    "未找到 wecom-cli 可执行文件，插件安装可能不完整。\n" +
      `尝试过的位置：\n  ${located.tried.join("\n  ")}\n` +
      "可通过 openclaw 配置 channels.wecom.cli.binPath 显式指定二进制路径。",
  );
}

export type ExecuteCliOptions = {
  accountId?: string | null;
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  timeoutMs?: number;
  /** Fallbacks must use a startup-prewarmed credential and never auth inline. */
  allowAuth?: boolean;
  /** Diagnostic marker used by MCP's narrow fallback path. */
  via?: string;
};

export async function executeWecomCli(
  rawArgs: unknown,
  options: ExecuteCliOptions = {},
): Promise<CliToolResult> {
  let argv: string[];
  try {
    argv = normalizeArgs(rawArgs);
  } catch (error) {
    if (error instanceof CliArgvError) {
      return errorResult(error.message, options.via ? { via: options.via } : undefined);
    }
    throw error;
  }

  let config: OpenClawConfig;
  try {
    config = loadConfig(normalizeConfig(options.getConfig?.() ?? options.config));
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error), {
      ...(options.via ? { via: options.via } : {}),
    });
  }
  let bot: ResolvedCliBot;
  let binary: { binPath: string; source: string };
  try {
    bot = resolveCliBot(config, options.accountId);
    binary = resolveBinPath(config, bot.accountId);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error), {
      ...(options.via ? { via: options.via } : {}),
    });
  }

  const commandForLog = redactSecret(argv.join(" "), bot.secret);
  return serialize(bot.botId, async () => {
    const attempt = (force: boolean, timeoutMs?: number) =>
      ensureSynced({
        binPath: binary.binPath,
        botId: bot.botId,
        secret: bot.secret,
        env: bot.env,
        force,
        allowAuth: options.allowAuth,
      }).then((dir) => runCli(binary.binPath, argv, dir, bot.env, timeoutMs));

    try {
      let output = await attempt(false, options.timeoutMs);
      const payload = parseErrorPayload(output.stdout);
      const code = payload?.code ?? parseErrcode(output.stdout);
      if (
        options.allowAuth !== false &&
        output.status !== 0 &&
        code != null &&
        CLI_RESIGN_CODES.has(code)
      ) {
        console.warn(`${CLI_LOG} 凭据失效 (code=${code})，强制重签后重试：${commandForLog}`);
        output = await attempt(true, options.timeoutMs);
      }

      if (output.timedOut) {
        return errorResult(
          `命令执行超时（${(options.timeoutMs ?? CLI_TIMEOUT_MS) / 1000}s）：wecom-cli ${commandForLog}`,
          {
            stderr: redactSecret(output.stderr.slice(-2048), bot.secret) || undefined,
            ...(options.via ? { via: options.via } : {}),
          },
        );
      }
      if (output.status === 2) {
        console.warn(`${CLI_LOG} 命令不存在或参数非法 (exit 2) via=${binary.source}：${commandForLog}`);
        return errorResult(
          `命令不存在或参数非法：wecom-cli ${commandForLog}\n${redactSecret(output.stderr.trim(), bot.secret).slice(0, 1500)}`,
          {
            hint: "该命令在当前 wecom-cli 版本中不可用，技能文档可能与 CLI 版本不一致。可用 --help 查看可用子命令。",
            ...(options.via ? { via: options.via } : {}),
          },
        );
      }

      const errorPayload = parseErrorPayload(output.stdout);
      const rawErrcode = parseErrcode(output.stdout);
      if (output.status !== 0 || errorPayload) {
        const message = redactSecret(
          rewriteMessage(
            errorPayload?.message ??
              parseErrmsg(output.stdout) ??
              (output.stderr.trim() || `命令执行失败（exit ${output.status}）`),
          ),
          bot.secret,
        );
        const safeEndpoint = errorPayload?.endpoint
          ? redactEndpoint(errorPayload.endpoint, bot.secret)
          : undefined;
        const safeErrorPayload = errorPayload
          ? { ...errorPayload, ...(safeEndpoint ? { endpoint: safeEndpoint } : {}) }
          : undefined;
        console.warn(
          `${CLI_LOG} 调用失败 (${output.ms}ms, exit=${output.status}) ${commandForLog} → ${redactSecret(JSON.stringify(safeErrorPayload ?? output.stderr.slice(-500)), bot.secret)}`,
        );
        return errorResult(message, {
          ...(safeErrorPayload?.code != null || rawErrcode != null
            ? { errcode: safeErrorPayload?.code ?? rawErrcode }
            : {}),
          ...(safeEndpoint ? { endpoint: safeEndpoint } : {}),
          ...(safeErrorPayload?.status != null ? { httpStatus: safeErrorPayload.status } : {}),
          ...(options.via ? { via: options.via } : {}),
        });
      }

      const text = output.stdout.trim();
      console.log(
        `${CLI_LOG} ok (${output.ms}ms, ${output.stdoutBytes}B${output.stdoutTruncated ? " 已截断" : ""}) via=${binary.source} ${commandForLog}`,
      );
      if (output.stdoutTruncated) {
        const truncatedText =
          `${text}\n\n[输出过大已截断：原始 ${output.stdoutBytes} 字节，上限 ${CLI_MAX_OUTPUT_BYTES} 字节。请缩小查询范围（例如使用更精确的关键词、加上分页或筛选参数）后重试。]`;
        return options.via
          ? textResult({ result: truncatedText, via: options.via })
          : textResult(truncatedText);
      }
      if (options.via) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          return textResult(
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? { ...parsed, via: options.via }
              : { result: parsed, via: options.via },
          );
        } catch {
          return textResult({ result: text, via: options.via });
        }
      }
      return textResult(text);
    } catch (error) {
      if (error instanceof CliAuthError) {
        return errorResult(error.message, {
          ...(error.errcode != null ? { errcode: error.errcode } : {}),
          ...(options.via ? { via: options.via } : {}),
        });
      }
      const typed = error as { code?: string; message?: string };
      if (typed.code === "ENOENT") {
        return errorResult(
          `wecom-cli 可执行文件不存在：${binary.binPath}。插件安装可能不完整，请重新安装，或通过 channels.wecom.cli.binPath 指定路径。`,
          { ...(options.via ? { via: options.via } : {}) },
        );
      }
      if (typed.code === "EACCES") {
        return errorResult(
          `wecom-cli 没有执行权限：${binary.binPath}。请修复文件权限或重新安装插件。`,
          { ...(options.via ? { via: options.via } : {}) },
        );
      }
      const message = redactSecret(typed.message ?? String(error), bot.secret);
      console.error(`${CLI_LOG} 异常 ${commandForLog} → ${message}`);
      return errorResult(message, {
        ...(options.via ? { via: options.via } : {}),
      });
    }
  });
}

export interface CreateWeComCliToolOptions {
  accountId?: string | null;
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
}

export function createWeComCliTool(options: CreateWeComCliToolOptions = {}) {
  return {
    name: CLI_TOOL_NAME,
    label: "企业微信命令行",
    description: DESCRIPTION,
    parameters: {
      type: "object" as const,
      properties: {
        args: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "命令行中 `wecom-cli ` 之后的字符串数组，例如 [\"contact\",\"users\",\"search\",\"--json\",\"{\\\"keywords\\\":[\\\"张三\\\"]}\"]",
        },
      },
      required: ["args"],
      additionalProperties: false,
    },
    prepareArguments: prepareCliArguments,
    async execute(_toolCallId: string, params: unknown): Promise<CliToolResult> {
      const raw =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as { args?: unknown }).args
          : undefined;
      return executeWecomCli(raw, options);
    },
  };
}

export function createWeComCliToolFactory(): OpenClawPluginToolFactory {
  return (toolContext: OpenClawPluginToolContext) => {
    if (toolContext.messageChannel !== "wecom") return null;
    const accountId =
      String(
        (toolContext as OpenClawPluginToolContext & { accountId?: string }).accountId ??
          toolContext.agentAccountId ??
          "",
      ).trim() || undefined;
    return createWeComCliTool({
      accountId,
      getConfig: () =>
        toolContext.getRuntimeConfig?.() ?? toolContext.runtimeConfig ?? toolContext.config,
    });
  };
}

export function resetCliToolState(): void {
  queues.clear();
}

export { path as _path };

/** Convert an MCP method name into the CLI's resource/method path. */
export function cliArgsForMcpCall(
  category: string,
  method: string,
  args: Record<string, unknown>,
): string[] {
  const normalizedCategory = category.trim().toLowerCase();
  const normalizedMethod = method.trim();
  // The old robot-doc MCP used verb-first names. These are the pairs proven
  // in the repository's live MCP/CLI comparison; unknown combinations fail
  // closed instead of guessing a potentially mutating command.
  const legacyPaths: Record<string, string[]> = {
    create_doc: ["doc", "create"],
    sheet_get_info: ["sheet", "get"],
    sheet_append_data: ["sheet", "rows", "append"],
    edit_doc_content: ["doc", "contents", "append"],
    smartsheet_add_records: ["smartsheet", "records", "add"],
    smartsheet_update_records: ["smartsheet", "records", "update"],
    smartsheet_del_records: ["smartsheet", "records", "delete"],
    smartsheet_get_records: ["smartsheet", "records", "list"],
  };
  const legacy = normalizedCategory === "doc" ? legacyPaths[normalizedMethod] : undefined;
  if (legacy) return [...legacy, "--json", JSON.stringify(args)];

  let cliService = normalizedCategory;
  let relative: string;
  if (normalizedCategory === "doc") {
    const service = ["doc", "sheet", "smartsheet", "smartpage", "media"].find((candidate) =>
      normalizedMethod.startsWith(`${candidate}_`),
    );
    if (!service) {
      throw new CliArgvError(
        `无法把 MCP method ${JSON.stringify(method)} 安全映射到 doc/sheet/smartsheet/smartpage/media CLI 服务`,
      );
    }
    cliService = service;
    relative = normalizedMethod.slice(service.length + 1);
  } else {
    const aliases: Record<string, { service: string; methodPrefix: string }> = {
      msg: { service: "message", methodPrefix: "message_" },
      schedule: { service: "calendar", methodPrefix: "calendar_" },
    };
    const route = aliases[normalizedCategory] ?? {
      service: normalizedCategory,
      methodPrefix: `${normalizedCategory}_`,
    };
    if (!normalizedMethod.startsWith(route.methodPrefix)) {
      throw new CliArgvError(
        `无法把 MCP method ${JSON.stringify(method)} 安全映射到 ${route.service} CLI 服务`,
      );
    }
    cliService = route.service;
    relative = normalizedMethod.slice(route.methodPrefix.length);
  }
  const segments = relative.split("_").filter(Boolean);
  if (segments.length === 0) {
    throw new CliArgvError(`无法从 MCP method ${JSON.stringify(method)} 生成 CLI 命令路径`);
  }
  return [cliService, ...segments, "--json", JSON.stringify(args)];
}

export async function executeMcpFallback(
  category: string,
  method: string,
  args: Record<string, unknown>,
  options: { accountId: string; config?: OpenClawConfig; reason: string },
): Promise<unknown> {
  const cliArgs = cliArgsForMcpCall(category, method, args);
  const result = await executeWecomCli(cliArgs, {
    accountId: options.accountId,
    config: options.config,
    timeoutMs: CLI_FALLBACK_TIMEOUT_MS,
    allowAuth: false,
    via: `cli-fallback:${options.reason}`,
  });
  return result.details;
}
