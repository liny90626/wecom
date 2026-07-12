import { describe, expect, it } from "vitest";
import { hasVisibleReplyBody } from "./reply-visibility.js";

describe("hasVisibleReplyBody", () => {
  it.each([
    [{ text: "最终正文" }, "final", true],
    [{ text: "<think>只有思考</think>" }, "final", false],
    [{ text: "正在压缩上下文", isStatusNotice: true }, "block", false],
    [{ text: "工具摘要" }, "tool", false],
    [{ mediaUrl: "https://example.test/result.png" }, "tool", true],
  ] as const)("classifies %j as %s visibility=%s", (payload, kind, expected) => {
    expect(hasVisibleReplyBody(payload, kind)).toBe(expected);
  });
});
