import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every `openclaw/…` module the plugin imports must exist in the production
 * OpenClaw line, 2026.7.1-2 — the only line this plugin supports. A plugin
 * importing a subpath its host does not export no longer loads at all.
 *
 * Add a subpath only after confirming it in
 * `node_modules/openclaw/package.json#exports` (`npm view openclaw@2026.7.1-2
 * exports` works too). `resolvePreferredOpenClawTmpDir` comes from the focused
 * `temp-path` subpath rather than the broad `infra-runtime` barrel.
 */
const ALLOWED_OPENCLAW_MODULES = new Set([
  "openclaw/plugin-sdk/agent-harness",
  "openclaw/plugin-sdk/agent-runtime",
  "openclaw/plugin-sdk/channel-contract",
  "openclaw/plugin-sdk/channel-send-result",
  "openclaw/plugin-sdk/config-contracts",
  "openclaw/plugin-sdk/core",
  "openclaw/plugin-sdk/error-runtime",
  "openclaw/plugin-sdk/media-runtime",
  "openclaw/plugin-sdk/reply-runtime",
  "openclaw/plugin-sdk/routing",
  "openclaw/plugin-sdk/runtime-env",
  "openclaw/plugin-sdk/setup",
  "openclaw/plugin-sdk/temp-path",
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
