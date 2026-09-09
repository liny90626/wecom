import { describe, expect, it } from "vitest";
import { restoreFlattenedProgressTables } from "./progress_adapter.js";
import { toWeComMarkdownV2 } from "./markdown_adapter.js";

describe("restoreFlattenedProgressTables", () => {
  const table = "| 日期 | 区间 |\n|:---|---:|\n| 9/7 | 1/1 ~ 9/7 |\n| 9/8 | 1/1 ~ 8/31 |";

  it.each([
    table,
    `根因找到了。\n\n${table}\n\n继续验证。`,
    `${table}\n\n${table}`,
    `${table}\n\n另外一项。\n\n| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n\n结束。`,
    "| A | B |\n|---|---|\n| | 2 |\n| 3 | |",
    "| A | B |\n|---|---|\n| `x|y` | 2 |",
    "| A | B |\n|---|---|\n| x\\|y | 2 |",
    "| A | B |\n|---|---|\n| ``x`|y`` | 2 |",
  ])("restores complete flattened tables without changing cell contents: %s", (markdown) => {
    const flat = markdown.replace(/\s+/g, " ");
    const restored = restoreFlattenedProgressTables(flat);
    expect(restored).toBe(markdown);
    expect(restoreFlattenedProgressTables(restored)).toBe(restored);
    expect(toWeComMarkdownV2(restored, null)).toBe(restored);
  });

  it.each([
    "正文只有一个 | 符号",
    "区间 1 ~ 2 和 3 ~ 4",
    table,
    `开头\n${table}\n结尾`,
    "`| A | B | |---|---| | 1 | 2 |`",
    "```text | A | B | |---|---| | 1 | 2 | ```",
    "~~~text | A | B | |---|---| | 1 | 2 | ~~~",
    "| A | B | |---|---| | `x|y | 2 |",
    "| A | B | C | |---|---| | 1 | 2 |",
    "| A | B | |---|---| | 1 | 2 | 3 |",
    "| A | B | |---|---| | 1 |",
    "| A | B | |---|---| | 1 | 2",
    "| A | B | |---|---|",
    "| A | B | |--|---| | 1 | 2 |",
    "| A | |---| | 1 |",
    "| A |  | |---|---| | 1 | 2 |",
    "命令 a | b，表格 | A | B | |---|---| | 1 | 2 |",
  ])("leaves unsupported or ambiguous input unchanged: %s", (text) => {
    expect(restoreFlattenedProgressTables(text)).toBe(text);
  });

  it("does not globally reconstruct ordinary final-answer text", () => {
    const flat = "示例 | A | B | |---|---| | 1 | 2 |";
    expect(toWeComMarkdownV2(flat, null)).toBe(flat);
  });

  it("preserves every streaming prefix and completes the table when its row closes", () => {
    const flat = table.replace(/\s+/g, " ");
    for (let end = 1; end <= flat.length; end += 1) {
      const snapshot = flat.slice(0, end);
      const restored = restoreFlattenedProgressTables(snapshot);
      expect(restored.replace(/\s+/g, " ").trim()).toBe(snapshot.replace(/\s+/g, " ").trim());
    }
    expect(restoreFlattenedProgressTables(flat)).toBe(table);
  });
});
