import { describe, expect, it } from "vitest";
import { resolveMediaAwareFinishText } from "./monitor.js";

describe("resolveMediaAwareFinishText", () => {
  it("surfaces the failure when every media send failed", () => {
    expect(
      resolveMediaAwareFinishText({
        accumulatedText: "",
        hasMedia: false,
        hasMediaFailed: true,
        mediaErrorSummary: "文件发送失败：report.pdf",
        streamId: "stream-1",
      }),
    ).toBe("文件发送失败：report.pdf");
  });

  it("keeps the answer and appends a partial media failure", () => {
    expect(
      resolveMediaAwareFinishText({
        accumulatedText: "已完成分析。",
        hasMedia: true,
        hasMediaFailed: true,
        mediaErrorSummary: "文件发送失败：report.pdf",
        streamId: "stream-2",
      }),
    ).toBe("已完成分析。\n\n文件发送失败：report.pdf");
  });

  it("uses the success notice only when media was delivered", () => {
    expect(
      resolveMediaAwareFinishText({
        accumulatedText: "",
        hasMedia: true,
        hasMediaFailed: false,
        streamId: "stream-3",
      }),
    ).toBe("📎 文件已发送，请查收。");
  });
});
