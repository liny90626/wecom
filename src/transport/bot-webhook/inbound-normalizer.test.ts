import { beforeEach, describe, expect, it, vi } from "vitest";

import { processBotInboundMessage } from "./inbound-normalizer.js";
import { decryptWecomMediaWithMeta } from "../../media.js";

vi.mock("../../media.js", () => ({
  decryptWecomMediaWithMeta: vi.fn(),
}));

describe("processBotInboundMessage quote media", () => {
  const recordOperationalIssue = vi.fn();
  const logError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(decryptWecomMediaWithMeta).mockReset();
  });

  it("downloads quote.file for text messages", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockResolvedValue({
      buffer: Buffer.from("%PDF-1.7 test"),
      sourceContentType: "application/pdf",
      sourceFilename: "quoted.pdf",
      sourceUrl: "https://example.com/quoted.pdf",
    });

    const result = await processBotInboundMessage({
      target: {
        account: {
          accountId: "purple",
          encodingAESKey: "account-aes-key",
        },
        config: {
          channels: {
            wecom: {
              mediaMaxMb: 24,
            },
          },
        },
        runtime: {
          error: logError,
        },
      } as never,
      msg: {
        msgid: "msg-quote-file",
        msgtype: "text",
        text: { content: "看这个引用" },
        quote: {
          msgtype: "file",
          file: {
            url: "https://example.com/quoted.pdf",
          },
        },
      } as never,
      recordOperationalIssue,
    });

    expect(decryptWecomMediaWithMeta).toHaveBeenCalledWith(
      "https://example.com/quoted.pdf",
      "account-aes-key",
      expect.objectContaining({
        maxBytes: 24 * 1024 * 1024,
      }),
    );
    expect(result.media).toBeDefined();
    expect(result.media?.contentType).toBe("application/pdf");
    expect(result.body).toContain("[引用: 文件]");
  });

  it("keeps quote.voice as text only without media decryption", async () => {
    const result = await processBotInboundMessage({
      target: {
        account: {
          accountId: "purple",
          encodingAESKey: "account-aes-key",
        },
        config: {
          channels: {
            wecom: {
              mediaMaxMb: 24,
            },
          },
        },
        runtime: {
          error: logError,
        },
      } as never,
      msg: {
        msgid: "msg-quote-voice",
        msgtype: "text",
        text: { content: "这个语音引用是什么意思" },
        quote: {
          msgtype: "voice",
          voice: { content: "这里是语音转写文本" },
        },
      } as never,
      recordOperationalIssue,
    });

    expect(result.media).toBeUndefined();
    expect(result.body).toContain("[引用: 语音] 这里是语音转写文本");
    expect(decryptWecomMediaWithMeta).not.toHaveBeenCalled();
  });

  it("extracts first image from quote.mixed", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockResolvedValue({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      sourceContentType: "image/png",
      sourceFilename: "quoted.png",
      sourceUrl: "https://example.com/quoted.png",
    });

    const result = await processBotInboundMessage({
      target: {
        account: {
          accountId: "purple",
          encodingAESKey: "account-aes-key",
        },
        config: {
          channels: {
            wecom: {
              mediaMaxMb: 24,
            },
          },
        },
        runtime: {
          error: logError,
        },
      } as never,
      msg: {
        msgid: "msg-quote-mixed",
        msgtype: "text",
        text: { content: "看这个图文引用" },
        quote: {
          msgtype: "mixed",
          mixed: {
            msg_item: [
              { msgtype: "text", text: { content: "正文" } },
              { msgtype: "image", image: { url: "https://example.com/quoted.png", aeskey: "item-aes-key" } },
            ],
          },
        },
      } as never,
      recordOperationalIssue,
    });

    expect(result.media).toBeDefined();
    expect(result.media?.contentType).toBe("image/png");
    expect(decryptWecomMediaWithMeta).toHaveBeenCalledWith(
      "https://example.com/quoted.png",
      "item-aes-key",
      expect.any(Object),
    );
  });

  it("keeps every media item from a top-level mixed message in order", async () => {
    vi.mocked(decryptWecomMediaWithMeta)
      .mockResolvedValueOnce({
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        sourceContentType: "image/png",
        sourceFilename: "first.png",
        sourceUrl: "https://example.com/first.png",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from("%PDF-1.7 second"),
        sourceContentType: "application/pdf",
        sourceFilename: "second.pdf",
        sourceUrl: "https://example.com/second.pdf",
      });

    const result = await processBotInboundMessage({
      target: {
        account: { accountId: "purple", encodingAESKey: "account-aes-key" },
        config: { channels: { wecom: { mediaMaxMb: 24 } } },
        runtime: { error: logError },
      } as never,
      msg: {
        msgid: "msg-mixed-multi-media",
        msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "请一起看这两个附件" } },
            { msgtype: "image", image: { url: "https://example.com/first.png", aeskey: "image-key" } },
            { msgtype: "file", file: { url: "https://example.com/second.pdf", aeskey: "file-key" } },
          ],
        },
      } as never,
      recordOperationalIssue,
    });

    expect(result.body).toBe("请一起看这两个附件\n[image]\n[file]");
    expect(result.medias?.map((media) => media.filename)).toEqual(["first.png", "second.pdf"]);
    expect(result.media?.filename).toBe("first.png");
    expect(decryptWecomMediaWithMeta).toHaveBeenCalledTimes(2);
  });

  it("bounds each mixed download by the remaining aggregate byte budget", async () => {
    const firstBytes = 700 * 1024;
    const aggregateBytes = 1024 * 1024;
    vi.mocked(decryptWecomMediaWithMeta)
      .mockResolvedValueOnce({
        buffer: Buffer.alloc(firstBytes, 1),
        sourceContentType: "image/png",
        sourceFilename: "first.png",
        sourceUrl: "https://example.com/first.png",
      })
      .mockImplementationOnce(async (_url, _aesKey, options) => {
        expect(options?.maxBytes).toBe(aggregateBytes - firstBytes);
        throw new Error(`response body too large (>${options?.maxBytes} bytes)`);
      });

    const result = await processBotInboundMessage({
      target: {
        account: { accountId: "purple", encodingAESKey: "account-aes-key" },
        config: { channels: { wecom: { mediaMaxMb: 24 } } },
        runtime: { error: logError },
      } as never,
      msg: {
        msgid: "msg-mixed-aggregate-limit",
        msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "按顺序处理" } },
            {
              msgtype: "image",
              image: { url: "https://example.com/first.png", filename: "first.png" },
            },
            {
              msgtype: "file",
              file: { url: "https://example.com/second.pdf", filename: "second.pdf" },
            },
          ],
        },
      } as never,
      maxDownloadBytes: aggregateBytes,
      recordOperationalIssue,
    });

    expect(decryptWecomMediaWithMeta).toHaveBeenNthCalledWith(
      1,
      "https://example.com/first.png",
      "account-aes-key",
      expect.objectContaining({ maxBytes: aggregateBytes }),
    );
    expect(result.medias?.map((media) => media.filename)).toEqual(["first.png"]);
    expect(result.body).toBe(
      `按顺序处理\n[image]\n[file] (decryption failed: response body too large (>${aggregateBytes - firstBytes} bytes))`,
    );
    expect(result.mediaFailures).toEqual([
      {
        name: "second.pdf",
        error: `response body too large (>${aggregateBytes - firstBytes} bytes)`,
      },
    ]);
  });

  it("extracts the first file or video from quote.mixed", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockResolvedValue({
      buffer: Buffer.from("%PDF-1.7 quoted"),
      sourceContentType: "application/pdf",
      sourceFilename: "quoted.pdf",
      sourceUrl: "https://example.com/quoted.pdf",
    });

    const result = await processBotInboundMessage({
      target: {
        account: { accountId: "purple", encodingAESKey: "account-aes-key" },
        config: { channels: { wecom: { mediaMaxMb: 24 } } },
        runtime: { error: logError },
      } as never,
      msg: {
        msgid: "msg-quote-mixed-file",
        msgtype: "text",
        text: { content: "看引用附件" },
        quote: {
          msgtype: "mixed",
          mixed: {
            msg_item: [
              { msgtype: "text", text: { content: "引用说明" } },
              {
                msgtype: "file",
                file: {
                  url: "https://example.com/quoted.pdf",
                  aeskey: "quote-file-key",
                  filename: "quoted.pdf",
                },
              },
              { msgtype: "video", video: { url: "https://example.com/later.mp4" } },
            ],
          },
        },
      } as never,
      recordOperationalIssue,
    });

    expect(decryptWecomMediaWithMeta).toHaveBeenCalledOnce();
    expect(decryptWecomMediaWithMeta).toHaveBeenCalledWith(
      "https://example.com/quoted.pdf",
      "quote-file-key",
      expect.any(Object),
    );
    expect(result.media?.filename).toBe("quoted.pdf");
  });

  it("keeps successful mixed media and exposes a later decrypt failure", async () => {
    vi.mocked(decryptWecomMediaWithMeta)
      .mockResolvedValueOnce({
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        sourceContentType: "image/png",
        sourceFilename: "first.png",
        sourceUrl: "https://example.com/first.png",
      })
      .mockRejectedValueOnce(new Error("HTTP 403 forbidden"));

    const result = await processBotInboundMessage({
      target: {
        account: { accountId: "purple", encodingAESKey: "account-aes-key" },
        config: { channels: { wecom: { mediaMaxMb: 24 } } },
        runtime: { error: logError },
      } as never,
      msg: {
        msgid: "msg-mixed-partial-fail",
        msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "image", image: { url: "https://example.com/first.png", aeskey: "image-key" } },
            { msgtype: "file", file: { url: "https://example.com/expired.pdf", aeskey: "file-key" } },
          ],
        },
      } as never,
      recordOperationalIssue,
    });

    expect(result.medias?.map((media) => media.filename)).toEqual(["first.png"]);
    expect(result.body).toContain("[image]");
    expect(result.body).toContain("[file] (decryption failed: HTTP 403 forbidden)");
    expect(recordOperationalIssue).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining("reason=expired_or_forbidden") }),
    );
  });

  it("records expired_or_forbidden reason for quote media decrypt failure", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockRejectedValue(new Error("HTTP 403 forbidden"));

    const result = await processBotInboundMessage({
      target: {
        account: {
          accountId: "purple",
          encodingAESKey: "account-aes-key",
        },
        config: {
          channels: {
            wecom: {
              mediaMaxMb: 24,
            },
          },
        },
        runtime: {
          error: logError,
        },
      } as never,
      msg: {
        msgid: "msg-quote-fail",
        msgtype: "text",
        text: { content: "读取这个引用" },
        quote: {
          msgtype: "file",
          file: { url: "https://example.com/expired.pdf" },
        },
      } as never,
      recordOperationalIssue,
    });

    expect(result.media).toBeUndefined();
    expect(result.body).toContain("[quote:file]");
    expect(recordOperationalIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("reason=expired_or_forbidden"),
      }),
    );
  });

  it("downloads quote.image for text messages", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockResolvedValue({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      sourceContentType: "image/png",
      sourceFilename: "quoted.png",
      sourceUrl: "https://example.com/quoted.png",
    });

    const result = await processBotInboundMessage({
      target: {
        account: {
          accountId: "purple",
          encodingAESKey: "account-aes-key",
        },
        config: {
          channels: {
            wecom: {
              mediaMaxMb: 24,
            },
          },
        },
        runtime: {
          error: logError,
        },
      } as never,
      msg: {
        msgid: "msg-quote-image",
        msgtype: "text",
        text: { content: "看这个引用图片" },
        quote: {
          msgtype: "image",
          image: {
            url: "https://example.com/quoted.png",
          },
        },
      } as never,
      recordOperationalIssue,
    });

    expect(decryptWecomMediaWithMeta).toHaveBeenCalledWith(
      "https://example.com/quoted.png",
      "account-aes-key",
      expect.objectContaining({
        maxBytes: 24 * 1024 * 1024,
      }),
    );
    expect(result.media).toBeDefined();
    expect(result.media?.contentType).toBe("image/png");
    expect(result.body).toContain("[引用: 图片]");
  });

  it("downloads quote.video for text messages", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockResolvedValue({
      buffer: Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]),
      sourceContentType: "video/mp4",
      sourceFilename: "quoted.mp4",
      sourceUrl: "https://example.com/quoted.mp4",
    });

    const result = await processBotInboundMessage({
      target: {
        account: {
          accountId: "purple",
          encodingAESKey: "account-aes-key",
        },
        config: {
          channels: {
            wecom: {
              mediaMaxMb: 24,
            },
          },
        },
        runtime: {
          error: logError,
        },
      } as never,
      msg: {
        msgid: "msg-quote-video",
        msgtype: "text",
        text: { content: "看这个引用视频" },
        quote: {
          msgtype: "video",
          video: {
            url: "https://example.com/quoted.mp4",
          },
        },
      } as never,
      recordOperationalIssue,
    });

    expect(decryptWecomMediaWithMeta).toHaveBeenCalledWith(
      "https://example.com/quoted.mp4",
      "account-aes-key",
      expect.objectContaining({
        maxBytes: 24 * 1024 * 1024,
      }),
    );
    expect(result.media).toBeDefined();
    expect(result.media?.contentType).toBe("video/mp4");
    expect(result.body).toContain("[引用: 视频]");
  });

  it("prioritizes top-level media over quote media", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockResolvedValue({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      sourceContentType: "image/png",
      sourceFilename: "top-level.png",
      sourceUrl: "https://example.com/top-level.png",
    });

    const result = await processBotInboundMessage({
      target: {
        account: {
          accountId: "purple",
          encodingAESKey: "account-aes-key",
        },
        config: {
          channels: {
            wecom: {
              mediaMaxMb: 24,
            },
          },
        },
        runtime: {
          error: logError,
        },
      } as never,
      msg: {
        msgid: "msg-both-media",
        msgtype: "image",
        image: {
          url: "https://example.com/top-level.png",
        },
        quote: {
          msgtype: "file",
          file: {
            url: "https://example.com/quoted.pdf",
          },
        },
      } as never,
      recordOperationalIssue,
    });

    // Should have downloaded top-level image, not quote file
    expect(decryptWecomMediaWithMeta).toHaveBeenCalledWith(
      "https://example.com/top-level.png",
      "account-aes-key",
      expect.any(Object),
    );
    expect(decryptWecomMediaWithMeta).not.toHaveBeenCalledWith(
      expect.stringContaining("quoted.pdf"),
      expect.any(String),
      expect.any(Object),
    );
    expect(result.media?.contentType).toBe("image/png");
    expect(result.body).toBe("[image]");
  });

  it("classifies timeout error for quote media", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockRejectedValue(new Error("Request timeout after 15000ms"));

    const result = await processBotInboundMessage({
      target: {
        account: {
          accountId: "purple",
          encodingAESKey: "account-aes-key",
        },
        config: {
          channels: {
            wecom: {
              mediaMaxMb: 24,
            },
          },
        },
        runtime: {
          error: logError,
        },
      } as never,
      msg: {
        msgid: "msg-quote-timeout",
        msgtype: "text",
        text: { content: "下载这个文件" },
        quote: {
          msgtype: "file",
          file: { url: "https://example.com/slow.pdf" },
        },
      } as never,
      recordOperationalIssue,
    });

    expect(result.media).toBeUndefined();
    expect(recordOperationalIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("reason=timeout"),
      }),
    );
  });

  it("classifies decrypt error for quote media", async () => {
    vi.mocked(decryptWecomMediaWithMeta).mockRejectedValue(new Error("Bad decrypt"));

    const result = await processBotInboundMessage({
      target: {
        account: {
          accountId: "purple",
          encodingAESKey: "account-aes-key",
        },
        config: {
          channels: {
            wecom: {
              mediaMaxMb: 24,
            },
          },
        },
        runtime: {
          error: logError,
        },
      } as never,
      msg: {
        msgid: "msg-quote-decrypt-fail",
        msgtype: "voice",
        voice: { content: "这是语音转写" },
        quote: {
          msgtype: "image",
          image: { url: "https://example.com/bad.png" },
        },
      } as never,
      recordOperationalIssue,
    });

    expect(result.media).toBeUndefined();
    expect(recordOperationalIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("reason=decrypt"),
      }),
    );
  });
});
