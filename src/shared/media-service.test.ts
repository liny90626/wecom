import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseBodyTooLargeError } from "../http.js";
import { WecomInboundMediaTooLargeError, WecomMediaService } from "./media-service.js";

describe("WecomMediaService", () => {
  const fetchRemoteMedia = vi.fn();
  const saveMediaBuffer = vi.fn();

  beforeEach(() => {
    fetchRemoteMedia.mockReset();
    saveMediaBuffer.mockReset();
  });

  it("passes configured wecom mediaMaxMb to remote attachment fetches and saves", async () => {
    const service = new WecomMediaService(
      {
        channel: {
          media: {
            fetchRemoteMedia,
            saveMediaBuffer,
          },
        },
      } as never,
      {
        channels: {
          wecom: {
            mediaMaxMb: 24,
          },
        },
      } as never,
    );

    fetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("file"),
      contentType: "application/pdf",
      fileName: "sample.pdf",
    });
    saveMediaBuffer.mockResolvedValue({
      path: "/tmp/sample.pdf",
    });

    const event = {
      accountId: "default",
      attachments: [{ remoteUrl: "https://example.com/sample.pdf" }],
    } as never;

    const attachment = await service.normalizeFirstAttachment(event);

    expect(fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://example.com/sample.pdf",
      maxBytes: 24 * 1024 * 1024,
    });

    await service.saveInboundAttachment(event, attachment!);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      24 * 1024 * 1024,
      "sample.pdf",
    );
  });

  it("prefers account-specific mediaMaxMb for inbound saves", async () => {
    const service = new WecomMediaService(
      {
        channel: {
          media: {
            fetchRemoteMedia,
            saveMediaBuffer,
          },
        },
      } as never,
      {
        channels: {
          wecom: {
            mediaMaxMb: 24,
            accounts: {
              ops: {
                mediaMaxMb: 36,
              },
            },
          },
        },
      } as never,
    );

    saveMediaBuffer.mockResolvedValue({
      path: "/tmp/account-specific.pdf",
    });

    await service.saveInboundAttachment(
      {
        accountId: "ops",
      } as never,
      {
        buffer: Buffer.from("file"),
        contentType: "application/pdf",
        filename: "ops.pdf",
      },
    );

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      36 * 1024 * 1024,
      "ops.pdf",
    );
  });

  it("turns an oversized download into a limit the user can act on", async () => {
    // The raw failure is `response body too large (>25165824 bytes)`, which
    // names neither the limit nor where to change it.
    const service = new WecomMediaService(
      { channel: { media: { fetchRemoteMedia, saveMediaBuffer } } } as never,
      { channels: { wecom: { mediaMaxMb: 24 } } } as never,
    );
    fetchRemoteMedia.mockRejectedValue(new ResponseBodyTooLargeError(24 * 1024 * 1024));

    await expect(
      service.normalizeFirstAttachment({
        accountId: "default",
        attachments: [{ remoteUrl: "https://example.com/huge.mp4" }],
      } as never),
    ).rejects.toThrow(WecomInboundMediaTooLargeError);

    await expect(
      service.normalizeFirstAttachment({
        accountId: "default",
        attachments: [{ remoteUrl: "https://example.com/huge.mp4" }],
      } as never),
    ).rejects.toThrow(/24MB/);
  });

  it("does not disguise a network failure as a size limit", async () => {
    const service = new WecomMediaService(
      { channel: { media: { fetchRemoteMedia, saveMediaBuffer } } } as never,
      { channels: { wecom: { mediaMaxMb: 24 } } } as never,
    );
    fetchRemoteMedia.mockRejectedValue(new Error("socket hang up"));

    await expect(
      service.normalizeFirstAttachment({
        accountId: "default",
        attachments: [{ remoteUrl: "https://example.com/sample.pdf" }],
      } as never),
    ).rejects.toThrow("socket hang up");
  });

  it("rejects an oversized buffer before it reaches the core media store", async () => {
    const service = new WecomMediaService(
      { channel: { media: { fetchRemoteMedia, saveMediaBuffer } } } as never,
      { channels: { wecom: { mediaMaxMb: 1 } } } as never,
    );

    await expect(
      service.saveInboundAttachment({ accountId: "default" } as never, {
        buffer: Buffer.alloc(2 * 1024 * 1024),
        contentType: "video/mp4",
        filename: "huge.mp4",
      }),
    ).rejects.toThrow(WecomInboundMediaTooLargeError);
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });
});
