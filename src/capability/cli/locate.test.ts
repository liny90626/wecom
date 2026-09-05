import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  binCandidatesFromPackageManifest,
  locateCliBinary,
  resetLocateCache,
} from "./locate.js";

let root: string;

afterEach(() => {
  resetLocateCache();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("wecom-cli binary lookup", () => {
  it("honors an explicit executable path and marks its source", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-locate-"));
    const binary = path.join(root, "wecom-cli");
    fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(binary, 0o755);
    expect(locateCliBinary(binary)).toEqual({
      ok: true,
      binPath: path.resolve(binary),
      source: "channels.wecom.cli.binPath",
    });
  });

  it("reports an unusable explicit path without falling back to PATH", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-locate-"));
    const result = locateCliBinary(path.join(root, "missing"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.tried[0]).toContain("配置指定");
  });

  it("accepts only package-manifest bin paths inside the package", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-locate-"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ bin: { "wecom-cli": "bin/wecom.js", bad: "../outside" } }),
    );
    expect(binCandidatesFromPackageManifest(root)).toEqual([path.join(root, "bin/wecom.js")]);
  });

  it("supports a string bin declaration", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-cli-locate-"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ bin: "bin/wecom.js" }));
    expect(binCandidatesFromPackageManifest(root)).toEqual([path.join(root, "bin/wecom.js")]);
  });
});
