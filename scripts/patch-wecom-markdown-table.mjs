#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FILE = path.join(ROOT, "src", "wecom_msg_adapter", "markdown_adapter.ts");
const TEST_FILE = path.join(ROOT, "src", "wecom_msg_adapter", "markdown_adapter.test.ts");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function status() {
  const markdown = read(FILE);
  const test = read(TEST_FILE);
  const build = run("npm", ["run", "build"]);
  const focusedTest = run("npx", ["vitest", "run", "src/wecom_msg_adapter/markdown_adapter.test.ts"]);

  const keepsTableIntact =
    markdown.includes("keep Markdown table blocks intact after stitching") &&
    markdown.includes("return stitched.join(\"\\n\");") &&
    !markdown.includes("tableToPlainText") &&
    !markdown.includes("out.push(...tableToPlainText");
  const testReady =
    test.includes("keeps markdown table grammar intact") &&
    test.includes("stitches broken table rows without converting them to plain text") &&
    test.includes("|---|---");
  const ready = keepsTableIntact && testReady && build.ok && focusedTest.ok;

  return {
    id: "B1",
    name: "WeCom markdown table keep intact",
    root: ROOT,
    markdownReady: keepsTableIntact,
    testReady,
    buildReady: build.ok,
    focusedTestReady: focusedTest.ok,
    status: ready ? "READY" : "NOT_READY",
    errors: {
      build: build.ok ? undefined : build.stderr || build.stdout,
      test: focusedTest.ok ? undefined : focusedTest.stderr || focusedTest.stdout,
    },
  };
}

const mode = process.argv[2] || "--check";
if (mode === "--check") {
  const current = status();
  console.log(JSON.stringify(current, null, 2));
  if (current.status !== "READY") process.exit(1);
} else if (mode === "--self-test") {
  const result = run("npx", ["vitest", "run", "src/wecom_msg_adapter/markdown_adapter.test.ts"]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (!result.ok) process.exit(1);
} else if (mode === "--dry-run" || mode === "--apply") {
  console.log(JSON.stringify({ status: "NOOP", reason: "B1 is implemented in tracked TypeScript source; run npm run build to emit dist." }, null, 2));
} else {
  console.error("Usage: node scripts/patch-wecom-markdown-table.mjs [--check|--self-test|--dry-run|--apply]");
  process.exit(2);
}
