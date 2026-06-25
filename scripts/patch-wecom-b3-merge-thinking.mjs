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
    reply.includes("normalizePeerKey(meta.peerId) !== peerKeyId") &&
    reply.includes("visibleReplyStarted") &&
    reply.includes("if (isEvent || supersededNoticeSent || visibleReplyStarted || streamSettled) return;") &&
    reply.includes("markFinalDelivered(currentFinalDeliveryKey, { peerDedup: !supersededByNewInbound })") &&
    reply.includes("closeSupersededPlaceholder") &&
    reply.includes("sendMarkdownChunksViaActivePush") &&
    reply.includes("reason: \"superseded-final\"") &&
    reply.includes("deliverNormalFinalViaStream(finalText)") &&
    reply.indexOf("supersededByNewInbound") < reply.indexOf("deliverNormalFinalViaStream(finalText)");
  const testReady =
    tests.includes("sends a merge notice when superseded") &&
    tests.includes("later pushes the old final without updating the old stream") &&
    tests.includes("matches superseded peer ids case-insensitively") &&
    tests.includes("does not let a superseded old final dedupe the newer same-peer final") &&
    tests.includes("does not overwrite an already visible old stream with a superseded notice") &&
    tests.includes("keeps the newer same-peer handle on the normal final stream path");
  const accountRuntime = read(path.join(SRC, "app", "account-runtime.ts"));
  const accountRuntimeTest = read(path.join(SRC, "app", "account-runtime.test.ts"));
  const dispatcher = read(path.join(SRC, "runtime", "dispatcher.ts"));
  const dispatcherTest = read(path.join(SRC, "runtime", "dispatcher.test.ts"));
  const runtimeWrapperReady =
    accountRuntime.includes("supersedeByNewInbound: (meta)") &&
    accountRuntime.includes("replyHandle.supersedeByNewInbound?.(meta)") &&
    accountRuntimeTest.includes("forwards supersedeByNewInbound through the runtime tracking wrapper");
  const dispatchTraceReady =
    dispatcher.includes("dispatch-core-start") &&
    dispatcher.includes("dispatch-core-done") &&
    dispatcher.includes("dispatch-core-aborted") &&
    dispatcher.includes("abortController.abort") &&
    dispatcherTest.includes("aborts the superseded same-peer dispatch and still dispatches the newer message to OpenClaw");
  const ready =
    appReady &&
    typeReady &&
    replyReady &&
    testReady &&
    runtimeWrapperReady &&
    dispatchTraceReady &&
    b2.ok &&
    build.ok;

  return {
    id: "B3",
    name: "WeCom Bot WS merge-thinking superseded-final",
    root: ROOT,
    appReady,
    typeReady,
    replyReady,
    testReady,
    runtimeWrapperReady,
    dispatchTraceReady,
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
