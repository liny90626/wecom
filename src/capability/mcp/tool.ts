import type {
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
import { resolveWecomSourceSnapshot } from "../../runtime/source-registry.js";
import { cleanSchemaForGemini } from "./schema.js";
import {
  clearWecomMcpCategoryCache,
  resolveWecomMcpBizType,
  sendJsonRpc,
  WECOM_MCP_BIZ_TYPES,
  type McpToolInfo,
} from "./transport.js";

type WecomMcpParams = {
  action: "list" | "call";
  category: string;
  method?: string;
  args?: string | Record<string, unknown>;
};

const LOG_TAG = "[wecom-mcp]";

/**
 * 企微判定「当前身份对该资源没有权限」的业务错误码。它们不一定是真的没授权——
 * 手上那份 MCP 配置过期、或者 biz_type 归一到了别的作用域，都会长这样，所以收到
 * 这类码要先把配置作废重取一次再下结论。
 */
const AUTHORITY_BIZ_ERROR_CODES = new Set([850002, 851003]);

/** 工具清单的输出上限。`doc` 一个品类就有 60+ 个工具，全量 schema 能吃掉一大块上下文。 */
const LIST_MAX_BYTES = 32_000;

type BizError = { errcode: number; errmsg: string };

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
  if (error && typeof error === "object" && "errcode" in error) {
    const errcode = Number((error as { errcode?: number }).errcode ?? 0);
    const errmsg = String((error as { errmsg?: string }).errmsg ?? `错误码: ${errcode}`);
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
    let parsed: { errcode?: unknown; errmsg?: unknown };
    try {
      parsed = JSON.parse(item.text) as typeof parsed;
    } catch {
      continue;
    }
    if (typeof parsed.errcode === "number" && parsed.errcode !== 0) {
      return { errcode: parsed.errcode, errmsg: String(parsed.errmsg ?? "") };
    }
  }
  return undefined;
}

function buildAuthorityHint(category: string, bizType: string, failure: BizError): string {
  return [
    `企微返回 ${failure.errcode}（${failure.errmsg || "no authority"}）：当前身份对该资源没有权限。`,
    "已自动重取一次 MCP 配置并重试，仍然失败。请依次确认：",
    "① 机器人管理后台「可使用权限」里对应能力是否仍在授权有效期内（文档类权限有效期 7 天，到期需成员重新授权）；",
    "② 目标资源是否在该能力的授权范围内；",
    "③ 智能表格的记录新增/更新在企业可见范围超过 10 人时会被官方限制，此时应改用该表「接收外部数据」的 Webhook 写入；",
    `④ 本次使用的 biz_type=${bizType}（由 category=${category} 归一而来）是否与目标资源匹配，官方取值为 ${WECOM_MCP_BIZ_TYPES.join("、")}。`,
  ].join("");
}

async function handleList(
  accountId: string,
  category: string,
  namePrefix: string | undefined,
): Promise<unknown> {
  const result = (await sendJsonRpc(accountId, category, "tools/list")) as
    | { tools?: McpToolInfo[] }
    | undefined;
  const { bizType } = resolveWecomMcpBizType(category);
  const all = result?.tools ?? [];
  const prefix = namePrefix?.trim();
  const selected = prefix ? all.filter((tool) => tool.name.startsWith(prefix)) : all;

  const detailed = {
    accountId,
    category,
    bizType,
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

  // 装不下就只给索引，并说清楚怎么拿到完整 schema——直接截断会让模型以为参数就长这样。
  console.warn(
    `${LOG_TAG} tools/list truncated account=${accountId} bizType=${bizType} count=${selected.length}`,
  );
  return {
    accountId,
    category,
    bizType,
    count: selected.length,
    truncated: true,
    note: `完整 schema 超过 ${LIST_MAX_BYTES} 字节，此处只列出名称与说明。把 method 设为名称前缀（如 smartsheet_）再调用一次 action=list 可取到该组工具的完整参数结构。`,
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
): Promise<unknown> {
  const send = (): Promise<unknown> =>
    sendJsonRpc(accountId, category, "tools/call", { name: method, arguments: args });

  const first = await send();
  const failure = extractBizError(first);
  if (!failure) return first;

  const { bizType } = resolveWecomMcpBizType(category);
  console.warn(
    `${LOG_TAG} biz error account=${accountId} bizType=${bizType} method=${method} errcode=${failure.errcode} errmsg=${failure.errmsg}`,
  );
  if (!AUTHORITY_BIZ_ERROR_CODES.has(failure.errcode)) {
    return first;
  }

  // 作废这份配置并重取一次。只重试一次：真的没授权时，重试第二次也只是把同一个
  // 错误再走一遍。
  clearWecomMcpCategoryCache(accountId, category);
  const retried = await send();
  const retryFailure = extractBizError(retried);
  if (!retryFailure || !AUTHORITY_BIZ_ERROR_CODES.has(retryFailure.errcode)) {
    return retried;
  }
  console.warn(
    `${LOG_TAG} biz error persists account=${accountId} bizType=${bizType} method=${method} errcode=${retryFailure.errcode}`,
  );
  return { ...(retried as Record<string, unknown>), hint: buildAuthorityHint(category, bizType, retryFailure) };
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
              "能力品类（企微 biz_type）：doc（文档、在线表格、智能表格、智能文档四者共用）、msg（消息）、mail（邮件）、todo（待办）、schedule（日程）、meeting（会议）、disk（微盘）、contact（通讯录）、media（素材）。各能力需在机器人后台单独授权，未授权时返回 851003。不确定某品类有哪些工具时先用 action=list。",
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
            return textResult({
              error: `必须提供 category（企微 biz_type），官方取值：${WECOM_MCP_BIZ_TYPES.join("、")}`,
            });
          }

          if (params.action === "list") {
            return textResult(await handleList(effectiveAccountId, params.category, params.method));
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
            ),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    };
  };
}
