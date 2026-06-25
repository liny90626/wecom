import { describe, expect, it } from "vitest";

import { chunkWeComMarkdownV2, toWeComMarkdownV2 } from "./markdown_adapter.js";

describe("toWeComMarkdownV2", () => {
  it("keeps markdown table grammar intact", () => {
    const input = [
      "| 项目 | 状态 | 备注 |",
      "|---|---:|---|",
      "| Markdown 标题 | ok | 当前消息测试 |",
      "| 表格渲染 | 待确认 | 看企微端 |",
    ].join("\n");

    expect(toWeComMarkdownV2(input, null)).toBe(input);
  });

  it("keeps tables intact inside normal markdown content", () => {
    const input = [
      "# 标题",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | **粗体** |",
      "",
      "- 列表",
    ].join("\n");

    expect(toWeComMarkdownV2(input, null)).toBe(input);
  });

  it("stitches broken table rows without converting them to plain text", () => {
    const input = [
      "| 项目 | 状态 | 备注 |",
      "|---|---:|---|",
      "| Markdown 标题 | ok",
      "",
      "| 当前消息测试 |",
    ].join("\n");

    expect(toWeComMarkdownV2(input, null)).toBe([
      "| 项目 | 状态 | 备注 |",
      "|---|---:|---|",
      "| Markdown 标题 | ok| 当前消息测试 |",
    ].join("\n"));
  });

  it("chunks long markdown without stripping table rows", () => {
    const input = [
      "| 项目 | 状态 |",
      "|---|---|",
      "| 表格 | 保留 |",
      "",
      "长文本。".repeat(1200),
    ].join("\n");

    const chunks = chunkWeComMarkdownV2(input);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toContain("|---|---|");
    expect(chunks.join("\n")).toContain("| 表格 | 保留 |");
  });
});
