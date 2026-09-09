/**
 * OpenClaw commentary callbacks can collapse all whitespace to spaces. Recover
 * only edge-pipe tables whose header, delimiter and complete rows agree.
 * Lost code-block structure and partial rows are ambiguous: retain that input,
 * as well as already multiline Markdown, without guessing.
 */
export function restoreFlattenedProgressTables(text: string): string {
  if (!text.includes("|---") && !/\|[ \t]*:?-{3}/.test(text)) return text;
  if (/[\r\n]/.test(text) || text.includes("```") || text.includes("~~~")) return text;

  // Count only structural pipes; inline code and escaped pipes are cell data.
  const cells: string[] = [];
  let start = 0;
  let codeTicks = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && !codeTicks) {
      i += 1;
    } else if (text[i] === "`") {
      let end = i + 1;
      while (text[end] === "`") end += 1;
      const ticks = end - i;
      if (!codeTicks) codeTicks = ticks;
      else if (codeTicks === ticks) codeTicks = 0;
      i = end - 1;
    } else if (text[i] === "|" && !codeTicks) {
      cells.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (codeTicks || !cells.length) return text;
  cells.push(text.slice(start));
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < cells.length - 1) {
    const prefix = cells[cursor]!.trim();
    const headerStart = cursor + 1;
    let seam = headerStart;
    while (seam < cells.length && cells[seam]!.trim()) seam += 1;
    const columns = seam - headerStart;
    const delimiterStart = seam + 1;
    if (columns < 2 || delimiterStart + columns >= cells.length) return text;
    const delimiter = cells.slice(delimiterStart, delimiterStart + columns);
    if (!delimiter.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))) return text;
    if (prefix) blocks.push(prefix);
    const rows = [
      `|${cells.slice(headerStart, seam).join("|")}|`,
      `|${delimiter.join("|")}|`,
    ];
    cursor = delimiterStart + columns;
    while (cursor < cells.length - 1 && !cells[cursor]!.trim()) {
      const end = cursor + columns + 1;
      if (end >= cells.length) return text;
      // An adjacent table may follow without prose between the two blocks.
      if (rows.length > 2 && !cells[end]!.trim() && end + columns < cells.length) {
        const nextDelimiter = cells.slice(end + 1, end + 1 + columns);
        if (nextDelimiter.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))) break;
      }
      rows.push(`|${cells.slice(cursor + 1, end).join("|")}|`);
      cursor = end;
    }
    if (rows.length < 3) return text;
    blocks.push(rows.join("\n"));
  }
  const suffix = cells[cursor]!.trim();
  if (suffix) blocks.push(suffix);
  return blocks.join("\n\n");
}
