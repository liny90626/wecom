/**
 * 按 UTF-8 字节切分文本。
 *
 * 企业微信消息上限以字节计，而 OpenClaw/SDK 的分片器按字符切分。
 * 先让调用方选择语法安全的字符边界，再逐轮收紧到字节上限；无法再按
 * 语法切分时，最后按码点硬切，避免拆开 emoji。
 */

const MAX_TIGHTEN_ROUNDS = 6;
const TIGHTEN_FACTOR = 0.8;

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function splitByUtf8Bytes(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of text) {
    const charBytes = utf8ByteLength(char);
    if (currentBytes > 0 && currentBytes + charBytes > maxBytes) {
      out.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) out.push(current);
  return out;
}

function nextCharLimit(piece: string, maxBytes: number, previousLimit: number): number {
  const density = utf8ByteLength(piece) / piece.length;
  const estimate = Math.floor(maxBytes / density);
  const tightened = Number.isFinite(previousLimit)
    ? Math.min(estimate, Math.floor(previousLimit * TIGHTEN_FACTOR))
    : estimate;
  return Math.max(1, tightened);
}

export function chunkTextToByteLimit(
  text: string,
  maxBytes: number,
  splitByChars: (value: string, charLimit: number) => string[],
): string[] {
  if (!text) return [];
  if (maxBytes <= 0 || utf8ByteLength(text) <= maxBytes) return [text];

  const out: string[] = [];
  const visit = (piece: string, previousLimit: number, round: number): void => {
    if (!piece) return;
    if (utf8ByteLength(piece) <= maxBytes) {
      out.push(piece);
      return;
    }
    if (round >= MAX_TIGHTEN_ROUNDS) {
      out.push(...splitByUtf8Bytes(piece, maxBytes));
      return;
    }

    const charLimit = nextCharLimit(piece, maxBytes, previousLimit);
    const parts = splitByChars(piece, charLimit).filter((part) => part.length > 0);
    if (parts.length <= 1) {
      out.push(...splitByUtf8Bytes(piece, maxBytes));
      return;
    }
    for (const part of parts) visit(part, charLimit, round + 1);
  };

  visit(text, Number.POSITIVE_INFINITY, 0);
  return out;
}
