import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadAndSendMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./media-uploader.js", () => ({
  uploadAndSendMedia: uploadAndSendMediaMock,
}));

import { sendMediaBatch } from "./monitor.js";

describe("sendMediaBatch", () => {
  beforeEach(() => {
    uploadAndSendMediaMock.mockReset();
  });

  const makeContext = () => ({
    wsClient: {} as never,
    frame: { body: { from: { userid: "alice" } } } as never,
    state: { accumulatedText: "", sentMediaUrls: [] as string[] },
    account: { accountId: "default", config: {} } as never,
    runtime: { log: vi.fn(), error: vi.fn() } as never,
  });

  it("does not resend a media URL already confirmed by the gateway", async () => {
    uploadAndSendMediaMock.mockResolvedValue({ ok: true, messageId: "m1" });
    const context = makeContext();

    await sendMediaBatch(context, ["/tmp/report.pdf", "/tmp/report.pdf"]);
    await sendMediaBatch(context, ["/tmp/report.pdf"]);

    expect(uploadAndSendMediaMock).toHaveBeenCalledTimes(1);
    expect(context.state.sentMediaUrls).toEqual(["/tmp/report.pdf"]);
    expect(context.state.hasMediaFailed).toBe(false);
  });

  it("keeps a failed URL retryable and clears its error after success", async () => {
    uploadAndSendMediaMock
      .mockResolvedValueOnce({ ok: false, error: "temporary gateway failure" })
      .mockResolvedValueOnce({ ok: true, messageId: "m2" });
    const context = makeContext();

    await sendMediaBatch(context, ["/tmp/report.pdf"]);
    expect(context.state.hasMediaFailed).toBe(true);
    expect(context.state.mediaErrorSummary).toContain("文件发送失败");

    await sendMediaBatch(context, ["/tmp/report.pdf"]);
    expect(uploadAndSendMediaMock).toHaveBeenCalledTimes(2);
    expect(context.state.hasMedia).toBe(true);
    expect(context.state.hasMediaFailed).toBe(false);
    expect(context.state.mediaErrorSummary).toBeUndefined();
  });
});

describe("sendMediaBatch failure copy", () => {
  it("points at mediaLocalRoots when the file sits outside the allowlist", async () => {
    uploadAndSendMediaMock.mockResolvedValue({
      ok: false,
      error: "Error: Local media path is not under an allowed directory: /srv/out/report.pdf",
    });
    const context = {
      wsClient: {} as never,
      frame: { body: { from: { userid: "alice" } } } as never,
      state: { accumulatedText: "" },
      account: { accountId: "default", config: {} } as never,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    };

    await sendMediaBatch(context, ["/srv/out/report.pdf"]);

    expect(context.state.mediaErrorSummary).toContain("mediaLocalRoots");
    expect(context.state.mediaErrorSummary).not.toContain("请稍后再试");
  });
});
