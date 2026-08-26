import { generateReqId } from "@wecom/aibot-node-sdk";
import { fetch as undiciFetch } from "undici";

import { resolveWecomAccount } from "../../config/accounts.js";
import { getBotWsPushHandle, getWecomRuntime } from "../../runtime.js";
import { PLUGIN_VERSION } from "../../version.js";

const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const MCP_CONFIG_FETCH_TIMEOUT_MS = 15_000;
const MCP_GET_CONFIG_CMD = "aibot_get_mcp_config";
const AIBOT_SEND_BIZ_MSG_CMD = "aibot_send_biz_msg";

/**
 * 官方 CLI 概述（doc 61944）列出的 `biz_type` 取值。**只用于日志提示**——
 * category 一律原样透传给企微（官方如此），这里不做任何改写。
 */
const OFFICIAL_BIZ_TYPES = new Set([
  "doc",
  "msg",
  "mail",
  "todo",
  "schedule",
  "meeting",
  "disk",
  "contact",
  "media",
]);
const BIZ_MSG_SEND_TIMEOUT_MS = 10_000;
/** `AiBotBizMsgType`：1 = 文档权限。 */
const AIBOT_BIZ_MSG_TYPE_DOC_READ_AUTH = 1;
/**
 * `initialize` 里的 clientInfo 版本，与官方插件逐字相同（官方硬编码 "1.0.0"）。
 * 这里不用插件版本——官方在 clientInfo 与 plugin_version 上发的是两个不同的值。
 */
const MCP_CLIENT_INFO_VERSION = "1.0.0";
const LOG_TAG = "[wecom-mcp]";

/**
 * 请求 MCP Server 时透传可信企微 userid 的 header 名。
 *
 * MCP 平面是「代替成员」操作的：不带这个 header，服务端不知道以谁的身份执行，
 * 对成员作用域的资源就会返回 `no authority`。取值必须是**原始大小写**。
 */
export const WECOM_USERID_HEADER = "x-openclaw-wecom-userid";

/** 与官方插件同形态：`OpenClawPlugin/<version> <platform>/<arch>`。 */
function buildUserAgent(): string {
  const archMap: Record<string, string> = { x64: "x86_64", ia32: "i386" };
  const arch = archMap[process.arch] ?? process.arch;
  return `OpenClawPlugin/${PLUGIN_VERSION} ${process.platform}/${arch}`;
}

const MCP_USER_AGENT = buildUserAgent();

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

// URL 里带着这次授权的凭证，日志只留 origin + path。
function redactUrl(url: string): string {
  return url.split(/[?#]/)[0] ?? "";
}

function cacheKey(accountId: string, category: string): string {
  return `${accountId}::${category}`;
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

/**
 * 读取账号里显式配置的 MCP Server 地址（`bot.mcpServers[bizType]`）。
 *
 * 这是官方文档列出的两种接入方式之一：后台「可使用权限 → 查看使用方式」复制的
 * streamableHTTP URL，形如 `https://qyapi.weixin.qq.com/mcp/v2/bot/doc?apikey=…`。
 * 那个 `apikey` 是**成员完成授权之后**才签发的，成员对文档的权限随它共享给
 * MCP 使用者；而 `aibot_get_mcp_config` 是走机器人长连接另行签发的，两者不必然
 * 等价——现网 `tools/list` 能过、单文档读取 851003，正是这种形态。
 */
function resolveConfiguredMcpUrl(accountId: string, bizType: string): string | undefined {
  const cfg = getWecomRuntime().config.loadConfig();
  const account = resolveWecomAccount({ cfg, accountId });
  const configured = account.bot?.config?.mcpServers?.[bizType];
  const url = String(configured ?? "").trim();
  return url || undefined;
}

async function fetchMcpConfig(
  accountId: string,
  category: string,
): Promise<Record<string, unknown>> {
  const handle = getBotWsPushHandle(accountId);
  if (!handle?.isConnected()) {
    throw new Error(`当前企微账号 MCP 服务未就绪：account=${accountId} 的 Bot WS 未连接。`);
  }

  const response = await withTimeout(
    handle.replyCommand({
      cmd: MCP_GET_CONFIG_CMD,
      body: {
        biz_type: category,
        // 官方发的是插件的真实版本号（运行时读 package.json）。我们此前发的是
        // 一个根本不是版本号的魔法串 "wecom-dual-plane"——而这次调用正是签发
        // 授权 URL 的那次，服务端若按它分档，非版本值很可能被归到最老的档位。
        plugin_version: PLUGIN_VERSION,
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

  // 现网实测的响应体：{ url, type, is_authed }。
  const body = (response as { body?: { url?: string; type?: unknown; is_authed?: unknown } }).body;
  if (!body?.url) {
    throw new Error(`MCP 配置响应缺少 url 字段 (account=${accountId}, category=${category})`);
  }

  // 后台签发的地址形如 /mcp/v2/bot/<biz_type>；实测这一代的 apikey 内嵌了
  // 「授权真人用户」，成员的文档才读得到。aibot_get_mcp_config 若给回别的形态，
  // 多半是上一代、未绑定真人用户的 Server——那会表现为「tools/list 能过、
  // 一读具体文档就 851003」。这种情况必须吵出来，否则只能靠猜。
  if (!String(body.url).includes("/mcp/v2/")) {
    console.warn(
      `${LOG_TAG} aibot_get_mcp_config 返回的不是 /mcp/v2/ 形态的地址（account=${accountId} category=${category}）——` +
        "它可能是未绑定授权真人用户的上一代 Server：品类级 tools/list 能过，但读写成员的文档会返回 851003。" +
        "若遇到该现象，请在 channels.wecom.accounts.<账号>.bot.mcpServers 里配上后台「查看使用方式」复制的地址。",
    );
  }

  // 现网实测这份响应是 { url, type, is_authed }。type 与 is_authed 是枚举/布尔，
  // 不是凭证，直接打出来——它们能在**调用前**就说明状态，不必等到 851003。
  // 其余键名仍只打名字，值一律不打。
  const knownKeys = new Set(["url", "type", "is_authed"]);
  const extraKeys = Object.keys(body).filter((key) => !knownKeys.has(key));
  console.log(
    `${LOG_TAG} config ready account=${accountId} category=${category} pluginVersion=${PLUGIN_VERSION}` +
      ` type=${String(body.type ?? "n/a")} isAuthed=${String(body.is_authed ?? "n/a")}` +
      (extraKeys.length > 0 ? ` otherKeys=[${extraKeys.join(",")}]` : "") +
      ` url=${redactUrl(String(body.url))}`,
  );
  if (body.is_authed === false) {
    console.warn(
      `${LOG_TAG} 该品类尚未授权（is_authed=false，account=${accountId} category=${category}）——` +
        "请到机器人管理后台「可使用权限」为该能力完成成员授权后再试。",
    );
  }
  return body as Record<string, unknown>;
}

/**
 * 让企微给用户发一张文档授权引导卡片（`aibot_send_biz_msg`）。
 *
 * `chat_id` 与 `userid` **大小写敏感**：必须用入站帧里的原文，不能拿 OpenClaw
 * 的 sessionKey 反解——core 会把 peer id 强制小写，小写后企微报 93006
 * invalid chatid（官方插件在同一处踩过并留了警告）。
 */
export async function sendWecomDocAuthCard(params: {
  accountId: string;
  chatId: string;
  chatType: "direct" | "group";
  requesterUserId?: string;
}): Promise<boolean> {
  const handle = getBotWsPushHandle(params.accountId);
  if (!handle?.isConnected()) {
    console.warn(`${LOG_TAG} doc-auth card skipped account=${params.accountId} reason=ws-not-connected`);
    return false;
  }
  const body: Record<string, unknown> = {
    biz_type: AIBOT_BIZ_MSG_TYPE_DOC_READ_AUTH,
    chat_id: params.chatId,
    chat_type: params.chatType === "group" ? 2 : 1,
  };
  if (params.requesterUserId) {
    body.userid = params.requesterUserId;
  }
  try {
    await withTimeout(
      handle.replyCommand({
        cmd: AIBOT_SEND_BIZ_MSG_CMD,
        body,
        headers: { req_id: generateReqId("biz_msg") },
      }),
      BIZ_MSG_SEND_TIMEOUT_MS,
      `aibot_send_biz_msg timed out after ${BIZ_MSG_SEND_TIMEOUT_MS}ms`,
    );
    console.log(
      `${LOG_TAG} doc-auth card sent account=${params.accountId} chatType=${params.chatType}`,
    );
    return true;
  } catch (error) {
    console.error(
      `${LOG_TAG} doc-auth card failed account=${params.accountId} error=${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function getMcpUrl(accountId: string, category: string): Promise<string> {
  const key = cacheKey(accountId, category);
  const cached = mcpConfigCache.get(key);
  if (cached?.url) {
    return String(cached.url);
  }
  const configured = resolveConfiguredMcpUrl(accountId, category);
  if (configured) {
    console.log(
      `${LOG_TAG} config from account settings account=${accountId} category=${category} url=${redactUrl(configured)}`,
    );
    mcpConfigCache.set(key, { url: configured, source: "account-config" });
    return configured;
  }
  const body = await fetchMcpConfig(accountId, category);
  mcpConfigCache.set(key, body);
  return String(body.url);
}

async function sendRawJsonRpc(
  url: string,
  session: McpSession,
  body: JsonRpcRequest,
  requesterUserId?: string,
): Promise<{ rpcResult: unknown; newSessionId: string | null }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": MCP_USER_AGENT,
    };
    if (session.sessionId) {
      headers["Mcp-Session-Id"] = session.sessionId;
    }
    const normalizedRequesterUserId = requesterUserId?.trim();
    if (normalizedRequesterUserId) {
      headers[WECOM_USERID_HEADER] = normalizedRequesterUserId;
    }

    // 官方在这里打了同样一行：出问题时第一件要确认的就是「这次到底带没带身份」。
    console.log(
      `${LOG_TAG} rpc → ${body.method} ${WECOM_USERID_HEADER}=${headers[WECOM_USERID_HEADER] ?? "(not set)"}`,
    );

    // 用 undici 的 fetch：Node 18.0–18.17 的原生 fetch 改不了 User-Agent，
    // 而 undici 本来就是本仓库的生产依赖，各版本行为一致。
    const response = (await undiciFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })) as unknown as Response;
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
  category: string,
  url: string,
  requesterUserId?: string,
): Promise<McpSession> {
  const key = cacheKey(accountId, category);
  const session: McpSession = { sessionId: null, initialized: false, stateless: false };

  const initializeRequest: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: generateReqId("mcp_init"),
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "wecom_mcp", version: MCP_CLIENT_INFO_VERSION },
    },
  };

  const initResult = await sendRawJsonRpc(url, session, initializeRequest, requesterUserId);
  // 打出对端是谁：现网曾经出现「后台签发的地址与 aibot_get_mcp_config 签发的
  // 地址是两台不同 Server」（一台 62 个新一代工具、一台 19 个旧一代），有这行
  // 当初一眼就能看出来。
  const serverInfo = (initResult.rpcResult as { serverInfo?: { name?: string; version?: string } } | undefined)
    ?.serverInfo;
  console.log(
    `${LOG_TAG} initialized account=${accountId} category=${category} server=${serverInfo?.name ?? "?"}/${serverInfo?.version ?? "?"}`,
  );
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
  const notifyResult = await sendRawJsonRpc(url, session, notifyRequest, requesterUserId);
  if (notifyResult.newSessionId) {
    session.sessionId = notifyResult.newSessionId;
  }
  session.initialized = true;
  mcpSessionCache.set(key, session);
  return session;
}

async function getOrCreateSession(
  accountId: string,
  category: string,
  url: string,
  requesterUserId?: string,
): Promise<McpSession> {
  const key = cacheKey(accountId, category);
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

  const promise = initializeSession(accountId, category, url, requesterUserId).finally(() => {
    inflightInitRequests.delete(key);
  });
  inflightInitRequests.set(key, promise);
  return promise;
}

async function rebuildSession(
  accountId: string,
  category: string,
  url: string,
  requesterUserId?: string,
): Promise<McpSession> {
  const key = cacheKey(accountId, category);
  const inflight = inflightInitRequests.get(key);
  if (inflight) return inflight;
  const promise = initializeSession(accountId, category, url, requesterUserId).finally(() => {
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
  const key = cacheKey(accountId, category);
  console.log(`${LOG_TAG} clear cache account=${accountId} category=${category}`);
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
  options?: { requesterUserId?: string },
): Promise<unknown> {
  if (!OFFICIAL_BIZ_TYPES.has(category.trim().toLowerCase())) {
    console.warn(
      `${LOG_TAG} category "${category}" 不在官方 biz_type 取值表内（${[...OFFICIAL_BIZ_TYPES].join("/")}）——已原样发给企微，但这类取值常见的表现就是拿回一个没有作用域的 URL`,
    );
  }
  const url = await getMcpUrl(accountId, category);
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: generateReqId("mcp_rpc"),
    method,
    ...(params !== undefined ? { params } : {}),
  };

  const requesterUserId = options?.requesterUserId;
  let session = await getOrCreateSession(accountId, category, url, requesterUserId);

  try {
    const result = await sendRawJsonRpc(url, session, body, requesterUserId);
    if (result.newSessionId) {
      session.sessionId = result.newSessionId;
    }
    return result.rpcResult;
  } catch (error) {
    if (error instanceof McpRpcError && CACHE_CLEAR_ERROR_CODES.has(error.code)) {
      clearWecomMcpCategoryCache(accountId, category);
    }
    if (session.stateless) {
      throw error;
    }
    if (error instanceof McpHttpError && error.statusCode === 404) {
      mcpSessionCache.delete(cacheKey(accountId, category));
      session = await rebuildSession(accountId, category, url, requesterUserId);
      const result = await sendRawJsonRpc(url, session, body, requesterUserId);
      if (result.newSessionId) {
        session.sessionId = result.newSessionId;
      }
      return result.rpcResult;
    }
    console.error(
      `${LOG_TAG} rpc failed account=${accountId} category=${category} method=${method} error=${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}
