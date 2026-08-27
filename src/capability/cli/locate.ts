/**
 * Resolve the CLI from the plugin dependency tree, never from PATH.
 * A global CLI may point at a different enterprise's default credential store.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

import { CLI_LOG } from "./const.js";

const requireFromPlugin = createRequire(import.meta.url);
const PACKAGE_PREFIX = "@wecom/cli";
const EXPLICIT_SOURCE = "channels.wecom.cli.binPath";

function platformSuffix(): string | undefined {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return undefined;
}

function binaryName(): string {
  return process.platform === "win32" ? "wecom-cli.exe" : "wecom-cli";
}

function isExecutable(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binCandidatesFromPackageRoot(root: string): string[] {
  return [path.join(root, "bin", binaryName()), path.join(root, binaryName())];
}

/** Read a package bin declaration while refusing paths outside that package. */
export function binCandidatesFromPackageManifest(root: string): string[] {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const values =
      typeof manifest.bin === "string"
        ? [manifest.bin]
        : manifest.bin && typeof manifest.bin === "object"
          ? [manifest.bin["wecom-cli"], ...Object.values(manifest.bin)]
          : [];
    const candidates: string[] = [];
    for (const value of values) {
      if (typeof value !== "string" || !value.trim()) continue;
      const candidate = path.resolve(root, value);
      const relative = path.relative(root, candidate);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
    return candidates;
  } catch {
    return [];
  }
}

export type LocateResult =
  | { ok: true; binPath: string; source: string }
  | { ok: false; tried: string[] };

let cached: Extract<LocateResult, { ok: true }> | undefined;
const logged = new Set<string>();

function logHit(binPath: string, source: string): void {
  if (logged.has(binPath)) return;
  logged.add(binPath);
  if (source === EXPLICIT_SOURCE) {
    console.warn(
      `${CLI_LOG} 二进制寻址命中 source=${source} path=${binPath}（来自配置显式指定，请确认它不是全局安装的 wecom-cli；配置目录仍由插件按会话机器人注入）`,
    );
    return;
  }
  console.log(`${CLI_LOG} 二进制寻址命中 source=${source} path=${binPath}`);
}

function checkCandidates(
  candidates: string[],
  source: string,
  tried: string[],
): Extract<LocateResult, { ok: true }> | undefined {
  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      const result = { ok: true as const, binPath: candidate, source };
      cached = result;
      logHit(candidate, source);
      return result;
    }
    tried.push(candidate);
  }
  return undefined;
}

/**
 * Locate the platform binary, preferring the optional platform package and
 * falling back to the main package's declared shim.
 */
export function locateCliBinary(explicitPath?: string): LocateResult {
  if (explicitPath?.trim()) {
    const candidate = path.resolve(explicitPath.trim());
    if (isExecutable(candidate)) {
      logHit(candidate, EXPLICIT_SOURCE);
      return { ok: true, binPath: candidate, source: EXPLICIT_SOURCE };
    }
    return { ok: false, tried: [`${candidate} (配置指定，但不存在或不可执行)`] };
  }

  if (cached?.ok) return cached;
  const tried: string[] = [];
  const suffix = platformSuffix();

  if (suffix) {
    const platformPackage = `${PACKAGE_PREFIX}-${suffix}`;
    try {
      const root = path.dirname(requireFromPlugin.resolve(`${platformPackage}/package.json`));
      const hit = checkCandidates(binCandidatesFromPackageRoot(root), platformPackage, tried);
      if (hit) return hit;
    } catch {
      tried.push(`${platformPackage} (未安装)`);
    }
  }

  try {
    const manifestPath = requireFromPlugin.resolve(`${PACKAGE_PREFIX}/package.json`);
    const root = path.dirname(manifestPath);
    if (suffix) {
      const platformPackage = `${PACKAGE_PREFIX}-${suffix}`;
      try {
        const requireFromMain = createRequire(manifestPath);
        const platformRoot = path.dirname(
          requireFromMain.resolve(`${platformPackage}/package.json`),
        );
        const hit = checkCandidates(binCandidatesFromPackageRoot(platformRoot), platformPackage, tried);
        if (hit) return hit;
      } catch {
        tried.push(`${platformPackage} (主包依赖中未找到)`);
      }
    }
    const hit = checkCandidates(
      [...binCandidatesFromPackageManifest(root), ...binCandidatesFromPackageRoot(root)],
      PACKAGE_PREFIX,
      tried,
    );
    if (hit) return hit;
  } catch {
    tried.push(`${PACKAGE_PREFIX} (未安装)`);
  }

  console.warn(`${CLI_LOG} 未找到 wecom-cli 二进制，尝试过：\n  ${tried.join("\n  ")}`);
  return { ok: false, tried };
}

export function resetLocateCache(): void {
  cached = undefined;
  logged.clear();
}
