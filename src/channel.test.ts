import { describe, expect, it } from "vitest";
import { buildMediaFailureFallbackText } from "./channel.js";

describe("buildMediaFailureFallbackText", () => {
  it("reports failure without exposing the local media path", () => {
    const path = "/home/alice/private/report.pdf";
    const text = buildMediaFailureFallbackText("已生成文件");

    expect(text).toContain("媒体发送失败");
    expect(text).not.toContain(path);
  });
});
