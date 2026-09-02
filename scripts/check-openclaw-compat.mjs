#!/usr/bin/env node
/**
 * Self-check: does this plugin still typecheck and pass its tests against
 * every OpenClaw line it claims to support?
 *
 *   node scripts/check-openclaw-compat.mjs                 # devDependency + latest
 *   node scripts/check-openclaw-compat.mjs 2026.7.1-2 2026.8.2
 *
 * For each version this installs `openclaw@<version>` under
 * `.openclaw-compat/<version>/` (cached; delete the directory to refresh),
 * builds a throwaway workspace whose `node_modules/openclaw` is that install
 * and whose other dependencies are links to the repo's, then runs `tsc` and
 * `vitest` there. The repo's own node_modules is never touched.
 *
 * OpenClaw 2026.8.x ships some `plugin-sdk` subpaths without declaration
 * files (their export map lacks `types`); for those the workspace gets a
 * minimal ambient declaration so the typecheck exercises OUR code rather than
 * failing on their packaging. Each shim is reported.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = path.join(repo, ".openclaw-compat");
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));

/** Ambient declarations for subpaths whose 2026.8.x packages ship no .d.ts. */
const TYPE_SHIMS = {
  "openclaw/plugin-sdk/file-access-runtime": `
declare module "openclaw/plugin-sdk/file-access-runtime" {
  export function readLocalFileFromRoots(options: {
    filePath: string;
    roots: readonly string[];
    label?: string;
    maxBytes?: number;
    symlinks?: "reject" | "follow-within-root";
    hardlinks?: "reject" | "allow";
    nonBlockingRead?: boolean;
  }): Promise<{ buffer: Buffer; realPath: string; root: string } | null>;
}
`,
};

// npm is a .cmd shim on Windows, which Node only runs through a shell.
const npmShell = process.platform === "win32";

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: cmd === "npm" && npmShell,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function capture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: cmd === "npm" && npmShell,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function resolveVersions(argv) {
  if (argv.length > 0) {
    return argv;
  }
  const pinned = pkg.devDependencies?.openclaw;
  if (!pinned) {
    throw new Error("package.json has no openclaw devDependency to use as the baseline");
  }
  const latest = capture("npm", ["view", "openclaw", "dist-tags.latest"]);
  return pinned === latest ? [pinned] : [pinned, latest];
}

function ensureInstalled(version) {
  const dir = path.join(cacheRoot, version);
  const installed = path.join(dir, "node_modules", "openclaw", "package.json");
  if (fs.existsSync(installed)) {
    return dir;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `openclaw-compat-${version}`, private: true }, null, 2),
  );
  console.log(`[compat] installing openclaw@${version} into ${path.relative(repo, dir)}`);
  const status = run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", `openclaw@${version}`],
    { cwd: dir },
  );
  if (status !== 0) {
    throw new Error(`npm install openclaw@${version} failed`);
  }
  return dir;
}

function link(target, linkPath) {
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(target, linkPath, type);
}

function buildWorkspace(version, installDir) {
  const workspace = path.join(cacheRoot, version, "workspace");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  const skip = new Set(["node_modules", "dist", ".git", ".openclaw-compat"]);
  for (const entry of fs.readdirSync(repo)) {
    if (skip.has(entry)) {
      continue;
    }
    fs.cpSync(path.join(repo, entry), path.join(workspace, entry), { recursive: true });
  }
  const nodeModules = path.join(workspace, "node_modules");
  fs.mkdirSync(nodeModules);
  for (const entry of fs.readdirSync(path.join(repo, "node_modules"))) {
    if (entry === "openclaw" || entry === ".bin" || entry === ".package-lock.json") {
      continue;
    }
    link(path.join(repo, "node_modules", entry), path.join(nodeModules, entry));
  }
  link(path.join(installDir, "node_modules", "openclaw"), path.join(nodeModules, "openclaw"));

  const openclawPkg = JSON.parse(
    fs.readFileSync(path.join(installDir, "node_modules", "openclaw", "package.json"), "utf8"),
  );
  const shims = [];
  for (const [specifier, declaration] of Object.entries(TYPE_SHIMS)) {
    const exportKey = `.${specifier.slice("openclaw".length)}`;
    const entry = openclawPkg.exports?.[exportKey];
    const js = typeof entry === "string" ? entry : entry?.default;
    const dts = typeof entry === "object" && entry?.types ? entry.types : js?.replace(/\.js$/, ".d.ts");
    const hasTypes = dts && fs.existsSync(path.join(installDir, "node_modules", "openclaw", dts));
    if (!hasTypes) {
      shims.push({ specifier, declaration });
    }
  }
  const tsconfig = JSON.parse(fs.readFileSync(path.join(workspace, "tsconfig.json"), "utf8"));
  if (shims.length > 0) {
    fs.writeFileSync(
      path.join(workspace, "openclaw-type-shims.d.ts"),
      shims.map((shim) => shim.declaration).join("\n"),
    );
    tsconfig.include = [...(tsconfig.include ?? []), "openclaw-type-shims.d.ts"];
    fs.writeFileSync(path.join(workspace, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  }
  return { workspace, openclawVersion: openclawPkg.version, shims: shims.map((shim) => shim.specifier) };
}

function main() {
  const versions = resolveVersions(process.argv.slice(2));
  const tsc = path.join(repo, "node_modules", "typescript", "bin", "tsc");
  const vitest = path.join(repo, "node_modules", "vitest", "vitest.mjs");
  const rows = [];
  for (const version of versions) {
    const installDir = ensureInstalled(version);
    const { workspace, openclawVersion, shims } = buildWorkspace(version, installDir);
    console.log(`\n[compat] openclaw ${openclawVersion}: typecheck`);
    const typecheck = run(process.execPath, [tsc, "-p", "tsconfig.json", "--noEmit"], { cwd: workspace });
    console.log(`\n[compat] openclaw ${openclawVersion}: tests`);
    const tests = run(process.execPath, [vitest, "run"], {
      cwd: workspace,
      env: { ...process.env, TMPDIR: os.tmpdir() },
    });
    rows.push({ version: openclawVersion, typecheck, tests, shims });
  }
  console.log("\n[compat] summary");
  for (const row of rows) {
    const shimNote = row.shims.length > 0 ? `  (type shims: ${row.shims.join(", ")})` : "";
    console.log(
      `  openclaw ${row.version}: typecheck ${row.typecheck === 0 ? "PASS" : "FAIL"}, tests ${row.tests === 0 ? "PASS" : "FAIL"}${shimNote}`,
    );
  }
  process.exit(rows.every((row) => row.typecheck === 0 && row.tests === 0) ? 0 : 1);
}

main();
