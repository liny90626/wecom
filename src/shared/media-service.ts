import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveWecomMediaDownloadTimeoutMs, resolveWecomMediaMaxBytes } from "../config/index.js";
import { ResponseBodyTooLargeError } from "../http.js";
import { decryptWecomMediaWithMeta } from "../media.js";
import type { UnifiedInboundEvent } from "../types/index.js";
import type { NormalizedMediaAttachment } from "./media-types.js";

/**
 * An inbound attachment the configured limit refuses.
 *
 * Its message is what the user reads: the raw failure is
 * `response body too large (>83886080 bytes)`, which says nothing about the
 * knob that produced it. Naming the limit and where to change it is the whole
 * point of this class.
 */
export class WecomInboundMediaTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(
      `附件超过当前配置的大小上限（${(maxBytes / (1024 * 1024)).toFixed(0)}MB），未能读取。` +
        "请压缩后重发，或调整 OpenClaw 的媒体大小配置。",
    );
    this.name = "WecomInboundMediaTooLargeError";
  }
}

/** A prefetch nobody consumed (dropped or superseded frame) is released after this. */
const PREFETCH_TTL_MS = 60_000;

export class WecomMediaService {
  private readonly prefetched = new Map<
    string,
    { download: Promise<NormalizedMediaAttachment | undefined>; expiry: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly core: PluginRuntime,
    private readonly cfg: OpenClawConfig,
  ) {}

  private resolveInboundMaxBytes(accountId: string): number {
    return resolveWecomMediaMaxBytes(this.cfg, accountId);
  }

  async downloadRemoteMedia(params: {
    url: string;
    maxBytes: number;
  }): Promise<NormalizedMediaAttachment> {
    const loaded = await this.core.channel.media.fetchRemoteMedia({
      url: params.url,
      maxBytes: params.maxBytes,
    });
    return {
      buffer: loaded.buffer,
      contentType: loaded.contentType,
      filename: loaded.fileName,
    };
  }

  /**
   * Download and decrypt WeCom AES-encrypted media.
   * Bot-ws: each message carries a unique per-URL aeskey in the message body.
   * Bot-webhook: uses the account-level EncodingAESKey.
   * Both use AES-256-CBC with PKCS#7 padding (32-byte block), IV = key[:16].
   */
  async downloadEncryptedMedia(params: {
    url: string;
    aesKey: string;
    maxBytes: number;
  }): Promise<NormalizedMediaAttachment> {
    const decrypted = await decryptWecomMediaWithMeta(params.url, params.aesKey, {
      maxBytes: params.maxBytes,
      // The same media.downloadTimeoutMs (30 s default) the webhook path honours;
      // the bare 15 s default was too short for a large file on a slow line.
      http: { timeoutMs: resolveWecomMediaDownloadTimeoutMs(this.cfg) },
    });
    return {
      buffer: decrypted.buffer,
      contentType: decrypted.sourceContentType,
      filename: decrypted.sourceFilename,
    };
  }

  async saveInboundAttachment(
    event: UnifiedInboundEvent,
    attachment: NormalizedMediaAttachment,
  ): Promise<string> {
    const maxBytes = this.resolveInboundMaxBytes(event.accountId);
    // Checked here rather than left to the core store: the core's own rejection
    // is a generic message the user cannot act on.
    if (attachment.buffer.length > maxBytes) {
      throw new WecomInboundMediaTooLargeError(maxBytes);
    }
    const saved = await this.core.channel.media.saveMediaBuffer(
      attachment.buffer,
      attachment.contentType,
      "inbound",
      maxBytes,
      attachment.filename,
    );
    return saved.path;
  }

  /**
   * Starts downloading the first attachment now, for a frame parked in the
   * media/text merge window: without it the download waited out the whole
   * window before it began. normalizeFirstAttachment picks the result up.
   */
  prefetchFirstAttachment(event: UnifiedInboundEvent): void {
    const key = prefetchKey(event);
    if (!key || this.prefetched.has(key)) {
      return;
    }
    const download = this.downloadFirstAttachment(event);
    // Observed by the consumer; a prefetch nobody consumes must not surface
    // as an unhandled rejection.
    download.catch(() => {});
    const expiry = setTimeout(() => this.prefetched.delete(key), PREFETCH_TTL_MS);
    expiry.unref?.();
    this.prefetched.set(key, { download, expiry });
  }

  async normalizeFirstAttachment(
    event: UnifiedInboundEvent,
  ): Promise<NormalizedMediaAttachment | undefined> {
    const key = prefetchKey(event);
    const prefetched = key ? this.prefetched.get(key) : undefined;
    if (key && prefetched) {
      this.prefetched.delete(key);
      clearTimeout(prefetched.expiry);
      return prefetched.download;
    }
    return this.downloadFirstAttachment(event);
  }

  private downloadFirstAttachment(
    event: UnifiedInboundEvent,
  ): Promise<NormalizedMediaAttachment | undefined> {
    const first = event.attachments?.[0];
    return first ? this.downloadAttachment(event, first) : Promise.resolve(undefined);
  }

  /** Downloads one of the event's attachments; the first goes through normalizeFirstAttachment. */
  async downloadAttachment(
    event: UnifiedInboundEvent,
    attachment: NonNullable<UnifiedInboundEvent["attachments"]>[number],
  ): Promise<NormalizedMediaAttachment | undefined> {
    if (!attachment.remoteUrl) {
      return undefined;
    }
    // Keep fetch/decrypt/save on the same account-aware limit instead of falling back
    // to the core media store default (5MB).
    const maxBytes = this.resolveInboundMaxBytes(event.accountId);
    try {
      // Bot-ws media is AES-encrypted; use decryption when aesKey is present
      if (attachment.aesKey) {
        return await this.downloadEncryptedMedia({
          url: attachment.remoteUrl,
          aesKey: attachment.aesKey,
          maxBytes,
        });
      }
      return await this.downloadRemoteMedia({ url: attachment.remoteUrl, maxBytes });
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new WecomInboundMediaTooLargeError(maxBytes);
      }
      throw error;
    }
  }
}

function prefetchKey(event: UnifiedInboundEvent): string | undefined {
  const url = event.attachments?.[0]?.remoteUrl;
  return url ? `${event.accountId}:${url}` : undefined;
}
