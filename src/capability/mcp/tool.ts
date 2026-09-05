import type {
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveWecomAccount } from "../../config/accounts.js";
import { getWecomRuntimeConfig } from "../../runtime.js";
import { resolveWecomSourceSnapshot } from "../../runtime/source-registry.js";
import { cleanSchemaForGemini } from "./schema.js";
import {
  clearWecomMcpCategoryCache,
  McpConfigError,
  sendJsonRpc,
  sendWecomDocAuthCard,
  type McpToolInfo,
} from "./transport.js";

type McpIdentity = {
  requesterUserId?: string;
  chatId?: string;
  chatType?: "direct" | "group";
};

type WecomMcpParams = {
  action: "list" | "call";
  category: string;
  method?: string;
  args?: string | Record<string, unknown>;
};

const LOG_TAG = "[wecom-mcp]";

/**
 * 需要清理缓存的业务错误码（对齐官方插件）：机器人授权过期 / 被重置，
 * 清掉配置与会话，下次调用重新拉取。
 */
const BIZ_CACHE_CLEAR_ERROR_CODES = new Set([850001, 851014]);

/**
 * 文档授权错误码（对齐官方插件）。命中时由企微直接给用户推一张授权引导卡片，
 * 并把原始 help_message 拦下不喂给 LLM——让模型转述授权步骤只会走样。
 */
const DOC_AUTH_ERROR_CODES = new Set([851013, 851014, 851008]);
const NO_CLI_FALLBACK_CODES = new Set([851013, 851014, 851008, 45009]);

type BizError = { errcode: number; errmsg: string; helpMessage?: string };

/**
 * `tools/list` 的完整 schema 输出上限。
 *
 * **阈值来自实测**（2026-08-26，`/mcp/v2/bot/*` 各能力）：
 *   contact 0.5KB · msg 5.8KB · todo 6.0KB · disk 6.4KB · schedule 8.8KB
 *   meeting 11.4KB · mail 12.8KB · **doc 289KB**（62 个工具）
 * 也就是说除 `doc` 外最大的也才 12.8KB，而 `doc` 是它的 22 倍——两者之间
 * 留出极宽的间隔。`doc` 只给名称+说明是 8.3KB，按前缀取则：smartpage_ 8.5KB、
 * doc_ 38KB、sheet_ 50KB、smartsheet_ 191KB。
 *
 * 上一版我按官方文档"估算"定过一个 32KB 的阈值，结果在旧一代 Server 的 19 个
 * 工具上就误伤了。这一版的数字是量出来的，不是猜的。
 */
const LIST_MAX_BYTES = 48_000;

function renderResultText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function textResult<TDetails>(data: TDetails) {
  return {
    content: [{ type: "text" as const, text: renderResultText(data) }],
    details: data,
  };
}

function errorResult(error: unknown) {
  const rawErrcode =
    error && typeof error === "object" ? (error as { errcode?: unknown }).errcode : undefined;
  if (rawErrcode !== undefined) {
    const errcode = Number(rawErrcode);
    const errmsg =
      typeof (error as { errmsg?: unknown }).errmsg === "string"
        ? (error as { errmsg: string }).errmsg
        : error instanceof Error
          ? error.message
          : `错误码: ${errcode}`;
    return textResult({ error: errmsg, errcode });
  }
  return textResult({
    error: error instanceof Error ? error.message : String(error),
  });
}

function parseArgs(args: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof SyntaxError ? error.message : String(error);
    throw new Error(`args 不是合法的 JSON: ${args} (${detail})`);
  }
}

function extractToolAccountId(ctx: OpenClawPluginToolContext): string | undefined {
  const explicit = String((ctx as { accountId?: string }).accountId ?? "").trim();
  if (explicit) return explicit;
  const agentAccountId = String(ctx.agentAccountId ?? "").trim();
  return agentAccountId || undefined;
}

/**
 * 企微把业务错误装在成功的 MCP 结果里：`content[].text` 是一段带 `errcode` 的 JSON。
 * 不是 JSON 的文本是正常返回，不当错误。
 */
function extractBizError(result: unknown): BizError | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (item.type !== "text" || !item.text) continue;
    let parsed: { errcode?: unknown; errmsg?: unknown; help_message?: unknown };
    try {
      parsed = JSON.parse(item.text) as typeof parsed;
    } catch {
      continue;
    }
    const errcode =
      typeof parsed.errcode === "number"
        ? parsed.errcode
        : typeof parsed.errcode === "string" && /^-?\d+$/.test(parsed.errcode)
          ? Number(parsed.errcode)
          : undefined;
    if (errcode !== undefined && errcode !== 0) {
      const helpMessage =
        typeof parsed.help_message === "string" ? parsed.help_message : undefined;
      return {
        errcode,
        errmsg: String(parsed.errmsg ?? ""),
        ...(helpMessage ? { helpMessage } : {}),
      };
    }
  }
  return undefined;
}

function hasCliCredentials(accountId: string, config?: OpenClawConfig): boolean {
  const cfg = config ?? getWecomRuntimeConfig();
  const account = resolveWecomAccount({ cfg, accountId });
  return Boolean(
    (account.bot?.ws?.botId?.trim() || account.bot?.botId?.trim()) &&
      (account.bot?.ws?.secret?.trim() || account.bot?.secret?.trim()),
  );
}

/**
 * Invoke the CLI only when MCP has definitely not executed a business method.
 * The dynamic import keeps the mature MCP module independent of the optional
 * CLI implementation in installations that do not use the new tool.
 */
async function tryCliFallback(params: {
  accountId: string;
  category: string;
  method: string;
  args: Record<string, unknown>;
  reason: string;
  config?: OpenClawConfig;
}): Promise<unknown | undefined> {
  if (!hasCliCredentials(params.accountId, params.config)) return undefined;
  console.warn(
    `${LOG_TAG} fallback → wecom-cli account=${params.accountId} category=${params.category} method=${params.method} reason=${params.reason}`,
  );
  const { executeMcpFallback } = await import("../cli/tool.js");
  const result = await executeMcpFallback(params.category, params.method, params.args, {
    accountId: params.accountId,
    config: params.config,
    reason: params.reason,
  });
  return result;
}

async function handleList(
  accountId: string,
  category: string,
  namePrefix: string | undefined,
  identity: McpIdentity,
): Promise<unknown> {
  const result = (await sendJsonRpc(accountId, category, "tools/list", undefined, {
    ...(identity.requesterUserId ? { requesterUserId: identity.requesterUserId } : {}),
  })) as { tools?: McpToolInfo[] } | undefined;
  const all = result?.tools ?? [];
  const prefix = namePrefix?.trim();
  const selected = prefix ? all.filter((tool) => tool.name.startsWith(prefix)) : all;

  const detailed = {
    accountId,
    category,
    count: selected.length,
    ...(prefix ? { namePrefix: prefix } : {}),
    tools: selected.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ? cleanSchemaForGemini(tool.inputSchema) : undefined,
    })),
  };
  if (Buffer.byteLength(renderResultText(detailed), "utf8") <= LIST_MAX_BYTES) {
    return detailed;
  }

  // 装不下就只给索引，并说清楚怎么按前缀取回完整 schema——直接截断会让模型
  // 以为参数就长这样。前缀分组是天然的切法：doc_ / sheet_ / smartsheet_ /
  // smartpage_ / media_ 各自都能装下。
  const prefixes = [...new Set(selected.map((tool) => tool.name.split("_")[0] ?? ""))].filter(
    Boolean,
  );
  console.warn(
    `${LOG_TAG} tools/list compacted account=${accountId} category=${category} count=${selected.length}`,
  );
  return {
    accountId,
    category,
    count: selected.length,
    truncated: true,
    note: `完整 schema 超过 ${LIST_MAX_BYTES} 字节，此处只列名称与说明。把 method 设为名称前缀（可用前缀：${prefixes.map((item) => `${item}_`).join(" / ")}）再调一次 action=list，即可取到该组工具的完整参数结构。`,
    tools: selected.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
    })),
  };
}

async function handleCall(
  accountId: string,
  category: string,
  method: string,
  args: Record<string, unknown>,
  identity: McpIdentity,
  config?: OpenClawConfig,
): Promise<unknown> {
  let result: unknown;
  try {
    result = await sendJsonRpc(
      accountId,
      category,
      "tools/call",
      { name: method, arguments: args },
      { ...(identity.requesterUserId ? { requesterUserId: identity.requesterUserId } : {}) },
    );
  } catch (error) {
    // Endpoint/config acquisition happens before the business RPC. It is safe
    // to use the member-scoped CLI when that layer is unavailable.
    if (
      error instanceof McpConfigError &&
      (error.errcode === undefined || !NO_CLI_FALLBACK_CODES.has(error.errcode))
    ) {
      const fallback = await tryCliFallback({
        accountId,
        category,
        method,
        args,
        reason: error.reason,
        config,
      });
      if (fallback !== undefined) return fallback;
    }
    throw error;
  }

  const failure = extractBizError(result);
  if (!failure) return result;
  console.warn(
    `${LOG_TAG} biz error account=${accountId} category=${category} method=${method} errcode=${failure.errcode} errmsg=${failure.errmsg} userid=${identity.requesterUserId ?? "(not set)"} raw=${JSON.stringify(result).slice(0, 600)}`,
  );

  if (failure.errcode === 851003) {
    // 851003 is an explicit server rejection, so the MCP method definitely
    // did not run. This is the only business error eligible for CLI fallback.
    const fallback = await tryCliFallback({
      accountId,
      category,
      method,
      args,
      reason: "851003",
      config,
    });
    if (fallback !== undefined) return fallback;
  }

  // 机器人授权过期/重置：作废配置与会话，下次调用重新拉取。
  if (BIZ_CACHE_CLEAR_ERROR_CODES.has(failure.errcode)) {
    clearWecomMcpCategoryCache(accountId, category);
  }

  if (category !== "doc" || !DOC_AUTH_ERROR_CODES.has(failure.errcode)) {
    return result;
  }

  // 文档授权错误：让企微直接给用户推一张授权引导卡片，并把原始 help_message
  // 拦下——由模型转述授权步骤只会走样，用户要点的是卡片。
  const { chatId, chatType, requesterUserId } = identity;
  let cardSent = false;
  if (chatId && chatType) {
    cardSent = await sendWecomDocAuthCard({ accountId, chatId, chatType, requesterUserId });
  } else {
    console.warn(
      `${LOG_TAG} doc-auth card skipped account=${accountId} reason=missing-chat-context chatId=${chatId ?? "n/a"} chatType=${chatType ?? "n/a"}`,
    );
  }

  return {
    content: [
      {
        type: "text",
        text: renderResultText({
          errcode: failure.errcode,
          errmsg: failure.errmsg || "authorization error",
          // 企微在返回里带 help_instruction，要求 help_message 逐字原样展示给用户。
          // 官方 2026.7.2 的拦截器把它丢掉了——那版代码早于这个字段。服务端对自己
          // 的载荷有最终解释权，这里保留原文，卡片只是额外的引导。
          ...(failure.helpMessage ? { help_message: failure.helpMessage } : {}),
          ...(failure.helpMessage
            ? {
                help_instruction:
                  "请将 help_message 字段的值逐字原样展示给用户，不要改写、删减或翻译。",
              }
            : {}),
          _biz_msg_sent: cardSent,
          _user_hint: cardSent
            ? "授权引导卡片已直接发送给用户；如上有 help_message，仍需按其要求逐字原样转达。"
            : "授权引导卡片未能发出。若上方有 help_message 请逐字原样转达；否则请让用户到企业微信「工作台 → 智能机器人 → 可使用权限」重新授权后重试。",
        }),
      },
    ],
  };
}

export function createWeComMcpToolFactory(): OpenClawPluginToolFactory {
  return (toolContext: OpenClawPluginToolContext) => {
    if (toolContext.messageChannel !== "wecom") {
      return null;
    }
    const accountId = extractToolAccountId(toolContext);
    const source = resolveWecomSourceSnapshot({
      accountId,
      sessionKey: toolContext.sessionKey,
      sessionId: toolContext.sessionId,
    });
    if (!source || source.source !== "bot-ws") {
      return null;
    }
    // 发起人 userid 取 OpenClaw core 提供的 requesterSenderId——它被 core 标注为
    // 「trusted sender id from inbound context」，是官方插件用的同一个来源。我们
    // 自己 registry 里那份只作兜底：工具注册时机比入站记录更早的话它会是空的。
    const trustedRequesterUserId =
      String((toolContext as { requesterSenderId?: string }).requesterSenderId ?? "").trim() ||
      undefined;
    const requesterUserId = trustedRequesterUserId ?? source.requesterUserId;
    // chatId / chatType 只能用我们自己存的原文：core 的 sessionKey 会把 peer id
    // 强制小写，而企微的 chat_id 大小写敏感（小写后 aibot_send_biz_msg 报 93006）。
    const identity: McpIdentity = {
      ...(requesterUserId ? { requesterUserId } : {}),
      ...(source.chatId ? { chatId: source.chatId } : {}),
      ...(source.peerKind ? { chatType: source.peerKind } : {}),
    };
    console.log(
      `${LOG_TAG} tool ready account=${accountId ?? "n/a"} userid=${requesterUserId ?? "(none)"} useridFrom=${trustedRequesterUserId ? "ctx.requesterSenderId" : source.requesterUserId ? "source-registry" : "none"} chatId=${source.chatId ?? "(none)"} chatType=${source.peerKind ?? "(none)"}`,
    );

    return {
      name: "wecom_mcp",
      label: "WeCom MCP",
      description:
        "企业微信 Bot WS MCP 工具。仅在 WeCom Bot WS 会话中可用，用于列出和调用企业微信 MCP 能力。",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: ["list", "call"],
            description: "操作类型：list 或 call",
          },
          category: {
            type: "string",
            description:
              "MCP 品类名称，如 doc、contact 等。官方取值：doc（文档、在线表格、智能表格、智能文档四者共用）、msg、mail、todo、schedule、meeting、disk、contact、media。各能力需在机器人后台单独授权。不确定某品类有哪些工具时先用 action=list。",
          },
          method: {
            type: "string",
            description:
              "action=call 时要调用的工具方法名；action=list 时可选，作为工具名前缀过滤（如 smartsheet_）。",
          },
          args: {
            type: "string",
            description: "action=call 时传入的 JSON 字符串参数，默认 {}",
          },
        },
        required: ["action", "category"],
      },
      async execute(_toolCallId: string, rawParams: unknown) {
        try {
          const params = rawParams as WecomMcpParams;
          const effectiveAccountId = extractToolAccountId(toolContext);
          if (!effectiveAccountId) {
            throw new Error("当前会话缺少 WeCom accountId，无法调用 wecom_mcp。");
          }
          if (!String(params.category ?? "").trim()) {
            return textResult({ error: "必须提供 category（企微 MCP 品类，如 doc、contact）" });
          }

          if (params.action === "list") {
            return textResult(
              await handleList(effectiveAccountId, params.category, params.method, identity),
            );
          }
          if (!params.method) {
            return textResult({ error: "action=call 时必须提供 method" });
          }
          return textResult(
            await handleCall(
              effectiveAccountId,
              params.category,
              params.method,
              parseArgs(params.args),
              identity,
              (toolContext.getRuntimeConfig?.() ??
                toolContext.runtimeConfig ??
                toolContext.config) as OpenClawConfig | undefined,
            ),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    };
  };
}
