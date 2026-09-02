import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every `openclaw/…` module the plugin imports must exist in BOTH OpenClaw
 * lines this plugin supports: 2026.7.1-2 and the current 2026.8.x. OpenClaw
 * 2026.8.1 removed the root barrel `openclaw/plugin-sdk` together with some
 * fifty subpaths, and a plugin importing any of them no longer loads at all.
 *
 * This list was checked against both export maps on 2026-09-02. Add a subpath
 * only after confirming it in `node_modules/openclaw/package.json#exports` of
 * BOTH versions (`npm view openclaw@<version> exports` works too).
 *
 * `infra-runtime` is deprecated upstream (removal target 2026-09-01, still
 * shipped in 2026.8.2) and kept only for `resolvePreferredOpenClawTmpDir`,
 * whose focused home (`file-access-runtime`) does not exist in 2026.7.1-2.
 */
const ALLOWED_OPENCLAW_MODULES = new Set([
  "openclaw/plugin-sdk/agent-harness",
  "openclaw/plugin-sdk/agent-runtime",
  "openclaw/plugin-sdk/channel-contract",
  "openclaw/plugin-sdk/channel-send-result",
  "openclaw/plugin-sdk/config-contracts",
  "openclaw/plugin-sdk/core",
  "openclaw/plugin-sdk/error-runtime",
  "openclaw/plugin-sdk/file-access-runtime",
  "openclaw/plugin-sdk/infra-runtime",
  "openclaw/plugin-sdk/media-runtime",
  "openclaw/plugin-sdk/reply-runtime",
  "openclaw/plugin-sdk/routing",
  "openclaw/plugin-sdk/runtime-env",
  "openclaw/plugin-sdk/setup",
]);

const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)"(openclaw(?:\/[^"]*)?)"/g;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("openclaw SDK import surface", () => {
  it("only imports subpaths that exist in every supported OpenClaw line", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const files = [...listSourceFiles(path.join(root, "src")), path.join(root, "index.ts")];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_RE)) {
        const specifier = match[1]!;
        if (!ALLOWED_OPENCLAW_MODULES.has(specifier)) {
          offenders.push(`${path.relative(root, file)}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
