import { describe, expect, it } from "vitest";
import { chunkTextToByteLimit, utf8ByteLength } from "./byte-chunking.js";

describe("chunkTextToByteLimit", () => {
  it("keeps every chunk within the byte limit without splitting emoji", () => {
    const chunks = chunkTextToByteLimit("😀中文".repeat(900), 2048, (value, limit) => {
      const parts: string[] = [];
      const codePoints = Array.from(value);
      for (let index = 0; index < codePoints.length; index += limit) {
        parts.push(codePoints.slice(index, index + limit).join(""));
      }
      return parts;
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => utf8ByteLength(chunk) <= 2048)).toBe(true);
    expect(chunks.every((chunk) => Buffer.from(chunk, "utf8").toString("utf8") === chunk)).toBe(true);
    expect(chunks.join("")).toBe("😀中文".repeat(900));
  });
});
