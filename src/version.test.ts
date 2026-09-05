import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PLUGIN_VERSION } from "./version.js";

describe("PLUGIN_VERSION", () => {
  it("与 package.json 保持一致", () => {
    // 这个常量会随 User-Agent 上线到企微，发版时漏改就会对不上。
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });
});
