import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadAndSendMediaMock = vi.hoisted(() => vi.fn());
const wsClientMock = vi.hoisted(() => ({
  isConnected: true,
  sendMessage: vi.fn(async () => ({ headers: { req_id: "push-1" } })),
}));

vi.mock("./media-uploader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media-uploader.js")>()),
  uploadAndSendMedia: uploadAndSendMediaMock,
}));

vi.mock("./state-manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state-manager.js")>()),
  getWeComWebSocket: () => wsClientMock,
}));

import { buildMediaFailureFallbackText, wecomPlugin } from "./channel.js";

describe("buildMediaFailureFallbackText", () => {
  it("reports failure without exposing the local media path", () => {
    const path = "/home/alice/private/report.pdf";
    const text = buildMediaFailureFallbackText("已生成文件");

    expect(text).toContain("媒体发送失败");
    expect(text).not.toContain(path);
  });
});

describe("outbound sendMedia over Bot WS", () => {
  const sendMedia = (mediaUrl: string) =>
    wecomPlugin.outbound!.sendMedia!({
      to: "wecom:alice",
      text: "报告已生成",
      mediaUrl,
      accountId: "default",
      cfg: { channels: { wecom: { botId: "bot", secret: "secret" } } } as never,
    } as never);

  beforeEach(() => {
    uploadAndSendMediaMock.mockReset();
    wsClientMock.sendMessage.mockClear();
  });

  it("fails the message tool when the upload fails, after telling the user", async () => {
    uploadAndSendMediaMock.mockResolvedValue({
      ok: false,
      error: "Local media path is not under an allowed directory: /srv/out/report.pdf",
    });

    await expect(sendMedia("/srv/out/report.pdf")).rejects.toThrow(/allowed directory/);
    const notices = wsClientMock.sendMessage.mock.calls.map(
      (call) => (call[1] as { markdown: { content: string } }).markdown.content,
    );
    expect(notices.join("\n")).toContain("媒体发送失败");
  });

  it("fails the message tool when WeCom rejects the file size", async () => {
    uploadAndSendMediaMock.mockResolvedValue({
      ok: false,
      rejected: true,
      rejectReason: "文件大小 25.00MB 超过了企业微信允许的最大限制 20MB，无法发送。",
    });

    await expect(sendMedia("/tmp/big.zip")).rejects.toThrow(/20MB/);
    expect(wsClientMock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("returns the gateway message id when the file went out", async () => {
    uploadAndSendMediaMock.mockResolvedValue({ ok: true, messageId: "media-1", finalType: "file" });

    await expect(sendMedia("/tmp/report.pdf")).resolves.toMatchObject({ messageId: "media-1" });
    // The caption travels as its own message after the file.
    expect(wsClientMock.sendMessage).toHaveBeenCalledTimes(1);
  });
});
