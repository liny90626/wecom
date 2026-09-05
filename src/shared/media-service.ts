import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveWecomMediaMaxBytes } from "../config/index.js";
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

export class WecomMediaService {
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

  async normalizeFirstAttachment(
    event: UnifiedInboundEvent,
  ): Promise<NormalizedMediaAttachment | undefined> {
    const first = event.attachments?.[0];
    if (!first?.remoteUrl) {
      return undefined;
    }
    // Keep fetch/decrypt/save on the same account-aware limit instead of falling back
    // to the core media store default (5MB).
    const maxBytes = this.resolveInboundMaxBytes(event.accountId);
    try {
      // Bot-ws media is AES-encrypted; use decryption when aesKey is present
      if (first.aesKey) {
        return await this.downloadEncryptedMedia({
          url: first.remoteUrl,
          aesKey: first.aesKey,
          maxBytes,
        });
      }
      return await this.downloadRemoteMedia({ url: first.remoteUrl, maxBytes });
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new WecomInboundMediaTooLargeError(maxBytes);
      }
      throw error;
    }
  }
}
