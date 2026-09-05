import { describe, expect, it } from "vitest";

import { BoundedOutputCollector } from "./process-output.js";

describe("BoundedOutputCollector", () => {
  it("keeps the head and reports original byte size", () => {
    const collector = new BoundedOutputCollector(5, "head");
    collector.append("abc");
    collector.append("def");
    expect(collector.result()).toEqual({ text: "abcde", originalBytes: 6, truncated: true });
  });

  it("keeps the tail", () => {
    const collector = new BoundedOutputCollector(5, "tail");
    collector.append("abc");
    collector.append("def");
    expect(collector.result()).toEqual({ text: "bcdef", originalBytes: 6, truncated: true });
  });

  it("does not return a split UTF-8 code point", () => {
    const value = Buffer.from("a😀b", "utf8");
    const head = new BoundedOutputCollector(2, "head");
    head.append(value);
    expect(head.result().text).toBe("a");

    const tail = new BoundedOutputCollector(2, "tail");
    tail.append(value);
    expect(tail.result().text).toBe("b");
  });

  it("supports a disabled collector without losing byte accounting", () => {
    const collector = new BoundedOutputCollector(0);
    collector.append("abc");
    expect(collector.result()).toEqual({ text: "", originalBytes: 3, truncated: true });
  });
});
