import crypto from "node:crypto";

import { resolveWecomEgressProxyUrlFromNetwork } from "../../config/index.js";
import { readResponseBodyAsBuffer, wecomFetch } from "../../http.js";
import { API_ENDPOINTS, LIMITS } from "../../types/constants.js";
import type { ResolvedAgentAccount } from "../../types/index.js";

type TokenCache = {
  token: string;
  expiresAt: number;
  refreshPromise: Promise<string> | null;
};

const tokenCaches = new Map<string, TokenCache>();

/**
 * WeCom answers these when the access token itself is no good (revoked, expired
 * early, issued for a rotated secret). The request was refused, not executed,
 * so it is safe to fetch a new token and send it once more.
 */
const ACCESS_TOKEN_ERRCODES = new Set([40001, 40014, 42001]);

export class WecomAccessTokenRejectedError extends Error {
  constructor(readonly errcode: number, message: string) {
    super(message);
    this.name = "WecomAccessTokenRejectedError";
  }
}

export function throwIfAccessTokenRejected(json: { errcode?: unknown; errmsg?: unknown } | null | undefined, label: string): void {
  const errcode = Number(json?.errcode);
  if (ACCESS_TOKEN_ERRCODES.has(errcode)) {
    throw new WecomAccessTokenRejectedError(errcode, `${label}: ${errcode} ${String(json?.errmsg ?? "")}`);
  }
}

// The secret is part of the key: after the corp secret is rotated in config the
// token issued for the old one must not be reused until it expires (~2 h).
function accessTokenCacheKey(agent: ResolvedAgentAccount): string {
  const secretTag = crypto.createHash("sha256").update(agent.corpSecret ?? "").digest("hex").slice(0, 12);
  return `${agent.corpId}:${String(agent.agentId ?? "na")}:${secretTag}`;
}

/**
 * Runs a token-authenticated call; if WeCom rejects the token, drops it and
 * runs the call once more with a fresh one. Before this a dead token was kept
 * until its nominal expiry, so every agent reply failed for up to two hours.
 */
export async function withFreshAccessToken<T>(
  agent: ResolvedAgentAccount,
  run: (token: string) => Promise<T>,
): Promise<T> {
  try {
    return await run(await getAccessToken(agent));
  } catch (error) {
    if (!(error instanceof WecomAccessTokenRejectedError)) {
      throw error;
    }
    tokenCaches.delete(accessTokenCacheKey(agent));
    console.warn(
      `[wecom-agent-api] access-token-rejected account=${agent.accountId} errcode=${error.errcode} — refetching once`,
    );
    return run(await getAccessToken(agent));
  }
}

function truncateForLog(raw: string, maxChars = 180): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}...(truncated)`;
}

export function normalizeUploadFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) return "file.bin";
  const ext = trimmed.includes(".") ? `.${trimmed.split(".").pop()!.toLowerCase()}` : "";
  const base = ext ? trimmed.slice(0, -ext.length) : trimmed;
  const sanitizedBase = base
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\/;=]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const safeBase = sanitizedBase || "file";
  const safeExt = ext.replace(/[^a-z0-9.]/g, "");
  return `${safeBase}${safeExt || ".bin"}`;
}

export function guessUploadContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const contentTypeMap: Record<string, string> = {
    jpg: "image/jpg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    amr: "voice/amr",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    mp4: "video/mp4",
    mov: "video/quicktime",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    odt: "application/vnd.oasis.opendocument.text",
    zip: "application/zip",
    rar: "application/vnd.rar",
    "7z": "application/x-7z-compressed",
    gz: "application/gzip",
    tgz: "application/gzip",
    tar: "application/x-tar",
  };
  return contentTypeMap[ext] || "application/octet-stream";
}

function requireAgentId(agent: ResolvedAgentAccount): number {
  if (typeof agent.agentId === "number" && Number.isFinite(agent.agentId)) return agent.agentId;
  throw new Error(`wecom agent account=${agent.accountId} missing agentId; sending via cgi-bin/message/send requires agentId`);
}

/**
 * 获取主企业的 access_token
 * 使用 corpid + corpsecret
 */
export async function getAccessToken(agent: ResolvedAgentAccount): Promise<string> {
  const cacheKey = accessTokenCacheKey(agent);
  let cache = tokenCaches.get(cacheKey);

  if (!cache) {
    cache = { token: "", expiresAt: 0, refreshPromise: null };
    tokenCaches.set(cacheKey, cache);
  }

  const now = Date.now();
  if (cache.token && cache.expiresAt > now + LIMITS.TOKEN_REFRESH_BUFFER_MS) {
    return cache.token;
  }

  if (cache.refreshPromise) {
    return cache.refreshPromise;
  }

  cache.refreshPromise = (async () => {
    try {
      const url = `${API_ENDPOINTS.GET_TOKEN}?corpid=${encodeURIComponent(agent.corpId)}&corpsecret=${encodeURIComponent(agent.corpSecret)}`;
      
      const res = await wecomFetch(url, undefined, {
        proxyUrl: resolveWecomEgressProxyUrlFromNetwork(agent.network),
        timeoutMs: LIMITS.REQUEST_TIMEOUT_MS,
      });
      const json = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };

      if (!json?.access_token) {
        throw new Error(`gettoken failed: ${json?.errcode} ${json?.errmsg}`);
      }

      cache!.token = json.access_token;
      cache!.expiresAt = Date.now() + (json.expires_in ?? 7200) * 1000;
      return cache!.token;
    } finally {
      cache!.refreshPromise = null;
    }
  })();

  return cache.refreshPromise;
}

/**
 * 获取下游企业的 access_token
 * 
 * 根据企业微信文档：https://developer.work.weixin.qq.com/document/path/95816
 * 
 * 请求方式：POST（HTTPS）
 * 请求地址：https://qyapi.weixin.qq.com/cgi-bin/corpgroup/corp/gettoken?access_token=ACCESS_TOKEN
 * 
 * 请求体：
 * {
 *   "corpid": "下游企业corpid",
 *   "business_type": 1,  // 1 表示上下游企业
 *   "agentid": 下游企业应用ID
 * }
 * 
 * 注意：需要使用上游企业的 access_token 作为调用凭证
 */
export async function getUpstreamAccessToken(params: {
  primaryAgent: ResolvedAgentAccount;
  upstreamCorpId: string;
  upstreamAgentId: number;
}): Promise<string> {
  const { primaryAgent, upstreamCorpId, upstreamAgentId } = params;

  // 缓存 key 增加 primaryCorpId 维度，避免多主企业之间碰撞
  const cacheKey = `upstream:${primaryAgent.corpId}:${upstreamCorpId}:${upstreamAgentId}`;
  let cache = tokenCaches.get(cacheKey);

  if (!cache) {
    cache = { token: "", expiresAt: 0, refreshPromise: null };
    tokenCaches.set(cacheKey, cache);
  }

  const now = Date.now();
  if (cache.token && cache.expiresAt > now + LIMITS.TOKEN_REFRESH_BUFFER_MS) {
    return cache.token;
  }

  if (cache.refreshPromise) {
    return cache.refreshPromise;
  }

  cache.refreshPromise = (async () => {
    try {
      // 1. 先获取上游企业的 access_token
      const primaryToken = await getAccessToken(primaryAgent);

      // 2. 调用 corpgroup/corp/gettoken 获取下游企业的 access_token
      const url = `https://qyapi.weixin.qq.com/cgi-bin/corpgroup/corp/gettoken?access_token=${encodeURIComponent(primaryToken)}`;
      
      const requestBody = {
        corpid: upstreamCorpId,
        business_type: 1,  // 1 表示上下游企业
        agentid: upstreamAgentId,
      };

      const res = await wecomFetch(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        },
        {
          proxyUrl: resolveWecomEgressProxyUrlFromNetwork(primaryAgent.network),
          timeoutMs: LIMITS.REQUEST_TIMEOUT_MS,
        },
      );
      
      const json = (await res.json()) as { 
        access_token?: string; 
        expires_in?: number; 
        errcode?: number; 
        errmsg?: string 
      };

      if (!json?.access_token) {
        throw new Error(`get upstream token failed: ${json?.errcode} ${json?.errmsg}`);
      }

      cache!.token = json.access_token;
      cache!.expiresAt = Date.now() + (json.expires_in ?? 7200) * 1000;
      return cache!.token;
    } finally {
      cache!.refreshPromise = null;
    }
  })();

  return cache.refreshPromise;
}

export function sendText(params: Parameters<typeof sendTextWithToken>[0]): Promise<void> {
  return withFreshAccessToken(params.agent, (token) => sendTextWithToken(params, token));
}

async function sendTextWithToken(params: {
  agent: ResolvedAgentAccount;
  toUser?: string;
  toParty?: string;
  toTag?: string;
  chatId?: string;
  text: string;
}, token: string): Promise<void> {
  const { agent, toUser, toParty, toTag, chatId, text } = params;
  console.log(
    `[wecom-agent-api] sendText request account=${agent.accountId} agentId=${String(agent.agentId ?? "N/A")} corpId=${agent.corpId} ` +
      `toUser=${toUser ?? ""} toParty=${toParty ?? ""} toTag=${toTag ?? ""} chatId=${chatId ?? ""} ` +
      `textLen=${text.length} textPreview=${JSON.stringify(truncateForLog(text))}`,
  );

  const useChat = Boolean(chatId);
  const url = useChat
    ? `${API_ENDPOINTS.SEND_APPCHAT}?access_token=${encodeURIComponent(token)}`
    : `${API_ENDPOINTS.SEND_MESSAGE}?access_token=${encodeURIComponent(token)}`;

  const body = useChat
    ? { chatid: chatId, msgtype: "text", text: { content: text } }
    : {
        touser: toUser,
        toparty: toParty,
        totag: toTag,
        msgtype: "text",
        agentid: requireAgentId(agent),
        text: { content: text },
      };

  const res = await wecomFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { proxyUrl: resolveWecomEgressProxyUrlFromNetwork(agent.network), timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
  );
  const json = (await res.json()) as {
    errcode?: number;
    errmsg?: string;
    invaliduser?: string;
    invalidparty?: string;
    invalidtag?: string;
  };

  console.log(
    `[wecom-agent-api] sendText response account=${agent.accountId} agentId=${String(agent.agentId ?? "N/A")} corpId=${agent.corpId} ` +
      `toUser=${toUser ?? ""} toParty=${toParty ?? ""} toTag=${toTag ?? ""} chatId=${chatId ?? ""} ` +
      `errcode=${String(json?.errcode ?? "N/A")} errmsg=${json?.errmsg ?? ""} ` +
      `invaliduser=${json?.invaliduser ?? ""} invalidparty=${json?.invalidparty ?? ""} invalidtag=${json?.invalidtag ?? ""}`,
  );

  throwIfAccessTokenRejected(json, "send failed");
  if (json?.errcode !== 0) {
    throw new Error(`send failed: ${json?.errcode} ${json?.errmsg}`);
  }

  if (json?.invaliduser || json?.invalidparty || json?.invalidtag) {
    const details = [
      json.invaliduser ? `invaliduser=${json.invaliduser}` : "",
      json.invalidparty ? `invalidparty=${json.invalidparty}` : "",
      json.invalidtag ? `invalidtag=${json.invalidtag}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(`send partial failure: ${details}`);
  }
}

export function uploadMedia(params: Parameters<typeof uploadMediaWithToken>[0]): Promise<string> {
  return withFreshAccessToken(params.agent, (token) => uploadMediaWithToken(params, token));
}

async function uploadMediaWithToken(params: {
  agent: ResolvedAgentAccount;
  type: "image" | "voice" | "video" | "file";
  buffer: Buffer;
  filename: string;
}, token: string): Promise<string> {
  const { agent, type, buffer, filename } = params;
  const safeFilename = normalizeUploadFilename(filename);
  const proxyUrl = resolveWecomEgressProxyUrlFromNetwork(agent.network);
  const url = `${API_ENDPOINTS.UPLOAD_MEDIA}?access_token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}&debug=1`;

  console.log(`[wecom-upload] Uploading media: type=${type}, filename=${safeFilename}, size=${buffer.length} bytes, corpId=${agent.corpId}`);

  const uploadOnce = async (fileContentType: string) => {
    const boundary = `----WebKitFormBoundary${crypto.randomBytes(16).toString("hex")}`;
    const header = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="media"; filename="${safeFilename}"; filelength=${buffer.length}\r\n` +
        `Content-Type: ${fileContentType}\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);

    console.log(`[wecom-upload] Multipart body size=${body.length}, boundary=${boundary}, fileContentType=${fileContentType}`);

    const res = await wecomFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
        },
        body,
      },
      { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
    );
    const json = (await res.json()) as { media_id?: string; errcode?: number; errmsg?: string };
    console.log(`[wecom-upload] Response:`, JSON.stringify(json));
    return json;
  };

  const preferredContentType = guessUploadContentType(safeFilename);
  let json = await uploadOnce(preferredContentType);
  throwIfAccessTokenRejected(json, "upload failed");

  if (!json?.media_id && preferredContentType !== "application/octet-stream") {
    console.warn(
      `[wecom-upload] Upload failed with ${preferredContentType}, retrying as application/octet-stream: ${json?.errcode} ${json?.errmsg}`,
    );
    json = await uploadOnce("application/octet-stream");
  }

  if (!json?.media_id) {
    throw new Error(`upload failed: ${json?.errcode} ${json?.errmsg}`);
  }
  return json.media_id;
}

export function sendMedia(params: Parameters<typeof sendMediaWithToken>[0]): Promise<void> {
  return withFreshAccessToken(params.agent, (token) => sendMediaWithToken(params, token));
}

async function sendMediaWithToken(params: {
  agent: ResolvedAgentAccount;
  toUser?: string;
  toParty?: string;
  toTag?: string;
  chatId?: string;
  mediaId: string;
  mediaType: "image" | "voice" | "video" | "file";
  title?: string;
  description?: string;
}, token: string): Promise<void> {
  const { agent, toUser, toParty, toTag, chatId, mediaId, mediaType, title, description } = params;

  const useChat = Boolean(chatId);
  const url = useChat
    ? `${API_ENDPOINTS.SEND_APPCHAT}?access_token=${encodeURIComponent(token)}`
    : `${API_ENDPOINTS.SEND_MESSAGE}?access_token=${encodeURIComponent(token)}`;

  const mediaPayload = mediaType === "video" ? { media_id: mediaId, title: title ?? "Video", description: description ?? "" } : { media_id: mediaId };
  const body = useChat
    ? { chatid: chatId, msgtype: mediaType, [mediaType]: mediaPayload }
    : {
        touser: toUser,
        toparty: toParty,
        totag: toTag,
        msgtype: mediaType,
        agentid: requireAgentId(agent),
        [mediaType]: mediaPayload,
      };

  const res = await wecomFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { proxyUrl: resolveWecomEgressProxyUrlFromNetwork(agent.network), timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
  );
  const json = (await res.json()) as {
    errcode?: number;
    errmsg?: string;
    invaliduser?: string;
    invalidparty?: string;
    invalidtag?: string;
  };

  throwIfAccessTokenRejected(json, `send ${mediaType} failed`);
  if (json?.errcode !== 0) {
    throw new Error(`send ${mediaType} failed: ${json?.errcode} ${json?.errmsg}`);
  }

  if (json?.invaliduser || json?.invalidparty || json?.invalidtag) {
    const details = [
      json.invaliduser ? `invaliduser=${json.invaliduser}` : "",
      json.invalidparty ? `invalidparty=${json.invalidparty}` : "",
      json.invalidtag ? `invalidtag=${json.invalidtag}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(`send ${mediaType} partial failure: ${details}`);
  }
}

export async function downloadMedia(params: {
  agent: ResolvedAgentAccount;
  mediaId: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; contentType: string; filename?: string }> {
  const { agent, mediaId } = params;
  const token = await getAccessToken(agent);
  const url = `${API_ENDPOINTS.DOWNLOAD_MEDIA}?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`;

  const res = await wecomFetch(url, undefined, {
    proxyUrl: resolveWecomEgressProxyUrlFromNetwork(agent.network),
    timeoutMs: LIMITS.REQUEST_TIMEOUT_MS,
  });

  if (!res.ok) {
    throw new Error(`download failed: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const disposition = res.headers.get("content-disposition") || "";
  const filename = (() => {
    const mStar = disposition.match(/filename\*\s*=\s*([^;]+)/i);
    if (mStar) {
      const raw = mStar[1]!.trim().replace(/^"(.*)"$/, "$1");
      const parts = raw.split("''");
      const encoded = parts.length === 2 ? parts[1]! : raw;
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    }
    const m = disposition.match(/filename\s*=\s*([^;]+)/i);
    if (!m) return undefined;
    return m[1]!.trim().replace(/^"(.*)"$/, "$1") || undefined;
  })();

  if (contentType.includes("application/json")) {
    const json = (await res.json()) as { errcode?: number; errmsg?: string };
    throw new Error(`download failed: ${json?.errcode} ${json?.errmsg}`);
  }

  const buffer = await readResponseBodyAsBuffer(res, params.maxBytes);
  return { buffer, contentType, filename };
}
