#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = path.join(ROOT, "src");
const FILES = {
  app: path.join(SRC, "app", "index.ts"),
  reply: path.join(SRC, "transport", "bot-ws", "reply.ts"),
  runtimeTypes: path.join(SRC, "types", "runtime.ts"),
  tests: path.join(SRC, "transport", "bot-ws", "reply.test.ts"),
};

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
  const app = read(FILES.app);
  const reply = read(FILES.reply);
  const runtimeTypes = read(FILES.runtimeTypes);
  const tests = read(FILES.tests);
  const b2 = run(process.execPath, ["scripts/patch-wecom-long-message.mjs", "--check"]);
  const build = run("npm", ["run", "build"]);

  const appReady =
    app.includes("previousPeerHandle") &&
    app.includes("previousPeerHandle.supersedeByNewInbound?.") &&
    app.includes("reason: \"new-inbound\"");
  const typeReady = runtimeTypes.includes("supersedeByNewInbound?:");
  const replyReady =
    reply.includes("B3_SUPERSEDED_NOTICE_TEXT") &&
    reply.includes("已收到新消息，合并思考。✅") &&
    reply.includes("supersededByNewInbound") &&
    reply.includes("supersedeByNewInbound: (meta)") &&
    reply.includes("closeSupersededPlaceholder") &&
    reply.includes("sendMarkdownChunksViaActivePush") &&
    reply.includes("reason: \"superseded-final\"") &&
    reply.includes("deliverNormalFinalViaStream(finalText)") &&
    reply.indexOf("supersededByNewInbound") < reply.indexOf("deliverNormalFinalViaStream(finalText)");
  const testReady =
    tests.includes("sends a merge notice when superseded") &&
    tests.includes("later pushes the old final without updating the old stream") &&
    tests.includes("keeps the newer same-peer handle on the normal final stream path");
  const ready = appReady && typeReady && replyReady && testReady && b2.ok && build.ok;

  return {
    id: "B3",
    name: "WeCom Bot WS merge-thinking superseded-final",
    root: ROOT,
    appReady,
    typeReady,
    replyReady,
    testReady,
    b2Ready: b2.ok,
    buildReady: build.ok,
    status: ready ? "READY" : "NOT_READY",
    errors: {
      b2: b2.ok ? undefined : b2.stderr || b2.stdout,
      build: build.ok ? undefined : build.stderr || build.stdout,
    },
  };
}

const mode = process.argv[2] || "--check";
if (mode === "--check") {
  const current = status();
  console.log(JSON.stringify(current, null, 2));
  if (current.status !== "READY") process.exit(1);
} else if (mode === "--dry-run" || mode === "--apply") {
  console.log(JSON.stringify({ status: "NOOP", reason: "B3 is implemented in tracked TypeScript source; run npm run build to emit dist." }, null, 2));
} else {
  console.error("Usage: node scripts/patch-wecom-b3-merge-thinking.mjs [--check|--dry-run|--apply]");
  process.exit(2);
}
