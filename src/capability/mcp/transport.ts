import { generateReqId } from "@wecom/aibot-node-sdk";
import { getBotWsPushHandle } from "../../runtime.js";

const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const MCP_CONFIG_FETCH_TIMEOUT_MS = 15_000;
const MCP_GET_CONFIG_CMD = "aibot_get_mcp_config";
const MCP_PLUGIN_VERSION = "wecom-dual-plane";
const LOG_TAG = "[wecom-mcp]";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpSession {
  sessionId: string | null;
  initialized: boolean;
  stateless: boolean;
}

const CACHE_CLEAR_ERROR_CODES = new Set([-32001, -32002, -32003]);

const mcpConfigCache = new Map<string, Record<string, unknown>>();
const mcpSessionCache = new Map<string, McpSession>();
const statelessKeys = new Set<string>();
const inflightInitRequests = new Map<string, Promise<McpSession>>();

/**
 * 官方 `biz_type` 取值表（企微 CLI 概述 doc 61944，2026-08-14）。
 *
 * 取值与能力名并不同名，靠猜必错三处：消息是 `msg` 不是 `message`、日程是
 * `schedule` 不是 `calendar`，而**表格 / 智能表格 / 智能文档三项与文档共用同一个
 * `doc`**。企微对认不出的 `biz_type` 不会报错，只会给回一个没有作用域的 URL，
 * 于是每次调用都返回 `851003 no authority`——看起来像权限问题，实际是品类错了。
 */
export const WECOM_MCP_BIZ_TYPES = [
  "doc",
  "msg",
  "mail",
  "todo",
  "schedule",
  "meeting",
  "disk",
  "contact",
  "media",
] as const;

const BIZ_TYPE_BY_ALIAS = new Map<string, string>([
  ["doc", "doc"],
  ["docs", "doc"],
  ["document", "doc"],
  ["documents", "doc"],
  ["wedoc", "doc"],
  ["文档", "doc"],
  ["sheet", "doc"],
  ["sheets", "doc"],
  ["spreadsheet", "doc"],
  ["表格", "doc"],
  ["在线表格", "doc"],
  ["smartsheet", "doc"],
  ["smart_sheet", "doc"],
  ["smart-sheet", "doc"],
  ["智能表格", "doc"],
  ["smartpage", "doc"],
  ["smart_page", "doc"],
  ["smart-page", "doc"],
  ["智能文档", "doc"],
  ["msg", "msg"],
  ["message", "msg"],
  ["messages", "msg"],
  ["消息", "msg"],
  ["mail", "mail"],
  ["mails", "mail"],
  ["email", "mail"],
  ["邮件", "mail"],
  ["todo", "todo"],
  ["todos", "todo"],
  ["待办", "todo"],
  ["schedule", "schedule"],
  ["schedules", "schedule"],
  ["calendar", "schedule"],
  ["calendars", "schedule"],
  ["日程", "schedule"],
  ["meeting", "meeting"],
  ["meetings", "meeting"],
  ["会议", "meeting"],
  ["disk", "disk"],
  ["drive", "disk"],
  ["wedrive", "disk"],
  ["微盘", "disk"],
  ["contact", "contact"],
  ["contacts", "contact"],
  ["通讯录", "contact"],
  ["media", "media"],
  ["素材", "media"],
]);

/**
 * 把模型给的品类归一到官方 `biz_type`。认不出的取值原样放行——官方随时可能加新
 * 品类，写死枚举会把插件锁在今天的表上；放行的同时标记 `recognized: false`，让
 * 日志与错误提示能指出这一点。
 */
export function resolveWecomMcpBizType(category: string): {
  bizType: string;
  recognized: boolean;
} {
  const raw = String(category ?? "").trim();
  const mapped = BIZ_TYPE_BY_ALIAS.get(raw.toLowerCase());
  return mapped ? { bizType: mapped, recognized: true } : { bizType: raw, recognized: false };
}

// URL 里带着这次授权的凭证，日志只留 origin + path。
function redactUrl(url: string): string {
  return url.split(/[?#]/)[0] ?? "";
}

function cacheKey(accountId: string, bizType: string): string {
  return `${accountId}::${bizType}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

export class McpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

export class McpHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

async function fetchMcpConfig(
  accountId: string,
  bizType: string,
): Promise<Record<string, unknown>> {
  const handle = getBotWsPushHandle(accountId);
  if (!handle?.isConnected()) {
    throw new Error(`当前企微账号 MCP 服务未就绪：account=${accountId} 的 Bot WS 未连接。`);
  }

  const response = await withTimeout(
    handle.replyCommand({
      cmd: MCP_GET_CONFIG_CMD,
      body: {
        biz_type: bizType,
        plugin_version: MCP_PLUGIN_VERSION,
      },
      headers: {
        req_id: generateReqId("mcp_config"),
      },
    }),
    MCP_CONFIG_FETCH_TIMEOUT_MS,
    `MCP config fetch timed out after ${MCP_CONFIG_FETCH_TIMEOUT_MS}ms`,
  );

  const errcode = Number((response as { errcode?: number }).errcode ?? 0);
  if (errcode !== 0) {
    throw new Error(
      `MCP 配置请求失败: errcode=${String((response as { errcode?: number }).errcode)} errmsg=${String((response as { errmsg?: string }).errmsg ?? "unknown")}`,
    );
  }

  const body = (response as { body?: { url?: string } }).body;
  if (!body?.url) {
    throw new Error(`MCP 配置响应缺少 url 字段 (account=${accountId}, bizType=${bizType})`);
  }

  console.log(
    `${LOG_TAG} config ready account=${accountId} bizType=${bizType} url=${redactUrl(String(body.url))}`,
  );
  return body as Record<string, unknown>;
}

async function getMcpUrl(accountId: string, bizType: string): Promise<string> {
  const key = cacheKey(accountId, bizType);
  const cached = mcpConfigCache.get(key);
  if (cached?.url) {
    return String(cached.url);
  }
  const body = await fetchMcpConfig(accountId, bizType);
  mcpConfigCache.set(key, body);
  return String(body.url);
}

async function sendRawJsonRpc(
  url: string,
  session: McpSession,
  body: JsonRpcRequest,
): Promise<{ rpcResult: unknown; newSessionId: string | null }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (session.sessionId) {
      headers["Mcp-Session-Id"] = session.sessionId;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const newSessionId = response.headers.get("mcp-session-id");

    if (!response.ok) {
      throw new McpHttpError(
        response.status,
        `MCP HTTP 请求失败: ${response.status} ${response.statusText}`,
      );
    }

    const contentLength = response.headers.get("content-length");
    if (response.status === 204 || contentLength === "0") {
      return { rpcResult: undefined, newSessionId };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return {
        rpcResult: await parseSseResponse(response),
        newSessionId,
      };
    }

    const text = await response.text();
    if (!text.trim()) {
      return { rpcResult: undefined, newSessionId };
    }

    const rpc = JSON.parse(text) as JsonRpcResponse;
    if (rpc.error) {
      throw new McpRpcError(
        rpc.error.code,
        `MCP 调用错误 [${rpc.error.code}]: ${rpc.error.message}`,
        rpc.error.data,
      );
    }
    return { rpcResult: rpc.result, newSessionId };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`MCP 请求超时 (${HTTP_REQUEST_TIMEOUT_MS}ms)`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function initializeSession(
  accountId: string,
  bizType: string,
  url: string,
): Promise<McpSession> {
  const key = cacheKey(accountId, bizType);
  const session: McpSession = { sessionId: null, initialized: false, stateless: false };

  const initializeRequest: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: generateReqId("mcp_init"),
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "wecom_mcp", version: MCP_PLUGIN_VERSION },
    },
  };

  const initResult = await sendRawJsonRpc(url, session, initializeRequest);
  if (initResult.newSessionId) {
    session.sessionId = initResult.newSessionId;
  }
  if (!session.sessionId) {
    session.stateless = true;
    session.initialized = true;
    statelessKeys.add(key);
    mcpSessionCache.set(key, session);
    return session;
  }

  const notifyRequest: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  };
  const notifyResult = await sendRawJsonRpc(url, session, notifyRequest);
  if (notifyResult.newSessionId) {
    session.sessionId = notifyResult.newSessionId;
  }
  session.initialized = true;
  mcpSessionCache.set(key, session);
  return session;
}

async function getOrCreateSession(
  accountId: string,
  bizType: string,
  url: string,
): Promise<McpSession> {
  const key = cacheKey(accountId, bizType);
  if (statelessKeys.has(key)) {
    const cached = mcpSessionCache.get(key);
    if (cached) return cached;
  }

  const cached = mcpSessionCache.get(key);
  if (cached?.initialized) {
    return cached;
  }

  const inflight = inflightInitRequests.get(key);
  if (inflight) {
    return inflight;
  }

  const promise = initializeSession(accountId, bizType, url).finally(() => {
    inflightInitRequests.delete(key);
  });
  inflightInitRequests.set(key, promise);
  return promise;
}

async function rebuildSession(
  accountId: string,
  bizType: string,
  url: string,
): Promise<McpSession> {
  const key = cacheKey(accountId, bizType);
  const inflight = inflightInitRequests.get(key);
  if (inflight) return inflight;
  const promise = initializeSession(accountId, bizType, url).finally(() => {
    inflightInitRequests.delete(key);
  });
  inflightInitRequests.set(key, promise);
  return promise;
}

async function parseSseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const lines = text.split("\n");
  let currentParts: string[] = [];
  let lastEventData = "";

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      currentParts.push(line.slice(6));
      continue;
    }
    if (line.startsWith("data:")) {
      currentParts.push(line.slice(5));
      continue;
    }
    if (line.trim() === "" && currentParts.length > 0) {
      lastEventData = currentParts.join("\n").trim();
      currentParts = [];
    }
  }
  if (currentParts.length > 0) {
    lastEventData = currentParts.join("\n").trim();
  }
  if (!lastEventData) {
    throw new Error("SSE 响应中未包含有效数据");
  }

  const rpc = JSON.parse(lastEventData) as JsonRpcResponse;
  if (rpc.error) {
    throw new McpRpcError(
      rpc.error.code,
      `MCP 调用错误 [${rpc.error.code}]: ${rpc.error.message}`,
      rpc.error.data,
    );
  }
  return rpc.result;
}

export function clearWecomMcpCategoryCache(accountId: string, category: string): void {
  const { bizType } = resolveWecomMcpBizType(category);
  const key = cacheKey(accountId, bizType);
  console.log(`${LOG_TAG} clear cache account=${accountId} bizType=${bizType}`);
  mcpConfigCache.delete(key);
  mcpSessionCache.delete(key);
  statelessKeys.delete(key);
  inflightInitRequests.delete(key);
}

export function clearWecomMcpAccountCache(accountId: string): void {
  const prefix = `${accountId}::`;
  for (const key of [...mcpConfigCache.keys()]) {
    if (key.startsWith(prefix)) mcpConfigCache.delete(key);
  }
  for (const key of [...mcpSessionCache.keys()]) {
    if (key.startsWith(prefix)) mcpSessionCache.delete(key);
  }
  for (const key of [...statelessKeys]) {
    if (key.startsWith(prefix)) statelessKeys.delete(key);
  }
  for (const key of [...inflightInitRequests.keys()]) {
    if (key.startsWith(prefix)) inflightInitRequests.delete(key);
  }
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export async function sendJsonRpc(
  accountId: string,
  category: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  // 归一只做一次，之后缓存键、配置请求、会话、日志全部用同一个 bizType——
  // 否则 "smartsheet" 与 "doc" 会各自持有一份指向同一作用域的配置与会话。
  const { bizType, recognized } = resolveWecomMcpBizType(category);
  if (!recognized) {
    console.warn(
      `${LOG_TAG} unknown category account=${accountId} category=${category} (原样发给企微；官方取值：${WECOM_MCP_BIZ_TYPES.join("/")})`,
    );
  }
  const url = await getMcpUrl(accountId, bizType);
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: generateReqId("mcp_rpc"),
    method,
    ...(params !== undefined ? { params } : {}),
  };

  let session = await getOrCreateSession(accountId, bizType, url);

  try {
    const result = await sendRawJsonRpc(url, session, body);
    if (result.newSessionId) {
      session.sessionId = result.newSessionId;
    }
    return result.rpcResult;
  } catch (error) {
    if (error instanceof McpRpcError && CACHE_CLEAR_ERROR_CODES.has(error.code)) {
      clearWecomMcpCategoryCache(accountId, bizType);
    }
    if (session.stateless) {
      throw error;
    }
    if (error instanceof McpHttpError && error.statusCode === 404) {
      mcpSessionCache.delete(cacheKey(accountId, bizType));
      session = await rebuildSession(accountId, bizType, url);
      const result = await sendRawJsonRpc(url, session, body);
      if (result.newSessionId) {
        session.sessionId = result.newSessionId;
      }
      return result.rpcResult;
    }
    console.error(
      `${LOG_TAG} rpc failed account=${accountId} bizType=${bizType} method=${method} error=${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}
