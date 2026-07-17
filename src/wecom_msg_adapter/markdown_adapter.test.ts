import { describe, expect, it } from "vitest";

import {
  chunkWeComMarkdownV2,
  previewWeComMarkdownV2,
  toWeComMarkdownV2,
} from "./markdown_adapter.js";

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

  it("uses compact chunk markers and preserves all chunk text", () => {
    const input = "长文本。".repeat(260);
    const formatted = toWeComMarkdownV2(input, null);
    const chunks = chunkWeComMarkdownV2(input, 120, 480);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("【第1/");
    expect(chunks.join("\n")).not.toContain("消息过长");
    const restored = chunks.join("").replace(/\n\n【第\d+\/\d+段】/g, "");
    expect(restored).toBe(formatted);
  });

  it("does not cut a long chunk near half capacity when a later sentence boundary fits", () => {
    const input = `${"甲".repeat(1_000)}\n\n${"乙。".repeat(1_000)}`;
    const chunks = chunkWeComMarkdownV2(input, 2_000, 12_000);
    const firstBody = (chunks[0] ?? "").replace(/\n\n【第\d+\/\d+段】$/, "");

    expect(chunks.length).toBeGreaterThan(1);
    expect(firstBody.length).toBeGreaterThanOrEqual(1_500);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 12_000)).toBe(true);
  });

  it("falls back to an earlier safe paragraph boundary instead of hard-splitting a long line", () => {
    const input = `${"甲".repeat(1_000)}\n\n${"乙".repeat(2_000)}`;
    const chunks = chunkWeComMarkdownV2(input, 2_000, 12_000);
    const firstBody = (chunks[0] ?? "").replace(/\n\n【第\d+\/\d+段】$/, "");

    expect(firstBody).toBe(`${"甲".repeat(1_000)}\n\n`);
  });

  it("keeps preview text free of chunk markers", () => {
    const preview = previewWeComMarkdownV2("预览内容。".repeat(260), 120, 480);

    expect(preview).toContain("预览内容。");
    expect(preview).not.toContain("【第");
    expect(preview).not.toContain("消息过长");
  });
});
