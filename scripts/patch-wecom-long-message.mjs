#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = path.join(ROOT, "src");
const FILES = {
  markdown: path.join(SRC, "wecom_msg_adapter", "markdown_adapter.ts"),
  reply: path.join(SRC, "transport", "bot-ws", "reply.ts"),
  outbound: path.join(SRC, "outbound.ts"),
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

function syntaxOk() {
  return run("npm", ["run", "build"]);
}

function status() {
  const markdown = read(FILES.markdown);
  const reply = read(FILES.reply);
  const outbound = read(FILES.outbound);
  const tests = read(FILES.tests);
  const b1 = run(process.execPath, ["scripts/patch-wecom-markdown-table.mjs", "--check"]);
  const build = syntaxOk();
  const focusedTest = run("npx", [
    "vitest",
    "run",
    "src/wecom_msg_adapter/markdown_adapter.test.ts",
    "src/transport/bot-ws/reply.test.ts",
    "src/outbound.test.ts",
  ]);

  const markdownReady =
    !markdown.includes("tableToPlainText") &&
    markdown.includes("return stitched.join(\"\\n\");") &&
    markdown.includes("export function chunkWeComMarkdownV2(") &&
    markdown.includes("export function previewWeComMarkdownV2(") &&
    markdown.includes("segmentMarkerV2") &&
    markdown.includes("【第${index}/${total}段】") &&
    markdown.includes("splitLongMarkdownCoreV2(formatted, maxChars, maxBytes)[0] ?? \"\"");
  const finalStreamFirstChunkReady =
    reply.includes("await params.client.replyStream(params.frame, finalStreamId, markdownChunks[0] ?? \"\", true)") ||
    (
      reply.includes("const firstStreamChunk = markdownChunks[0] ?? \"\"") &&
      reply.includes("await params.client.replyStream(params.frame, finalStreamId, firstStreamChunk, true)")
    ) ||
    (
      reply.includes("const firstStreamChunk = markdownChunks[0] ?? \"\"") &&
      reply.includes("withReplySendTimeout(") &&
      reply.includes("params.client.replyStream(params.frame, finalStreamId, firstStreamChunk, true)") &&
      reply.includes("\"stream final\"")
    ) ||
    (
      reply.includes("bodyText: markdownChunks[0] ?? \"\"") &&
      reply.includes("await params.client.replyStream(params.frame, finalStreamId, firstStreamChunk, true)")
    );
  const remainderPushReady =
    reply.includes("await params.client.sendMessage(peerId,") ||
    (
      reply.includes("withReplySendTimeout(") &&
      reply.includes("params.client.sendMessage(peerId,") &&
      reply.includes("\"stream remainder push\"")
    ) ||
    (
      reply.includes("await sendMarkdownChunksViaActivePush(finalText, {") &&
      reply.includes("reason: \"stream-remainder\"") &&
      reply.includes("progress.delivered = Math.max(progress.delivered, 1)") &&
      reply.includes("isObsolete: () => !isCurrentReplyActivation()")
    );
  const replyReady =
    reply.includes("chunkWeComMarkdownV2") &&
    reply.includes("previewWeComMarkdownV2") &&
    reply.includes("const B2_PEER_FINAL_DEDUP_TTL_MS = 120_000") &&
    reply.includes("const BLOCK_PREVIEW_MAX_MS = 300_000") &&
    reply.includes("const BLOCK_PREVIEW_MAX_CHARS = 3_000") &&
    reply.includes("withOptionalCompletionMarker") &&
    reply.includes("finalAppendCompletionMarker") &&
    reply.includes("dedupeLongFinalText(finalText, { previewFrozen })") &&
    reply.includes("function findRepeatedHeadingTail(") &&
    reply.includes("function findRepeatedStructuredTailDuplicateEnd(") &&
    reply.includes("function collectStructuredDedupeMarkers(") &&
    reply.includes("hasStructuredOverlapBeforeRepeatedTail(prior, tail)") &&
    reply.includes("recentFinalDeliveriesByPeer") &&
    reply.includes("let finalDelivered = false") &&
    reply.includes("markFinalDelivered") &&
    reply.includes("function mergeReplyText(") &&
    reply.includes("accumulatedText = mergeReplyText(accumulatedText, text)") &&
    reply.includes("await deliverBlockPreview(accumulatedText)") &&
    reply.includes("mergeReplyText(accumulatedText, text)") &&
    reply.includes("if (info.kind === \"block\")") &&
    reply.includes("const outboundText") &&
    reply.includes("deliverNormalFinalViaStream") &&
    finalStreamFirstChunkReady &&
    remainderPushReady &&
    !reply.includes("toWeComMarkdownV2(finalText),\n            info.kind === \"final\"");
  const testReady =
    tests.includes("keeps repeated large business blocks without an explicit structured restart") &&
    tests.includes("keeps an identical business paragraph when it belongs to different chapters") &&
    tests.includes("deduplicates repeated structured tails that restart from the same report heading") &&
    tests.includes("does not deduplicate repeated markdown table blocks") &&
    tests.includes("does not show chunk markers in thinking previews before the final text is complete") &&
    tests.includes("keeps enough body room when thinking preview is long");
  const outboundReady =
    outbound.includes("chunkWeComMarkdownV2") &&
    outbound.includes("Sending Bot WS active message chunk") &&
    outbound.includes("setTimeout(resolve, 800)");
  const ready =
    markdownReady &&
    replyReady &&
    testReady &&
    outboundReady &&
    b1.ok &&
    build.ok &&
    focusedTest.ok;

  return {
    id: "B2",
    name: "WeCom long markdown active bubble chunking",
    root: ROOT,
    markdownReady,
    replyReady,
    testReady,
    outboundReady,
    b1Ready: b1.ok,
    buildReady: build.ok,
    focusedTestReady: focusedTest.ok,
    status: ready ? "READY" : "NOT_READY",
    errors: {
      b1: b1.ok ? undefined : b1.stderr || b1.stdout,
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
  const result = run("npx", [
    "vitest",
    "run",
    "src/wecom_msg_adapter/markdown_adapter.test.ts",
    "src/transport/bot-ws/reply.test.ts",
    "src/outbound.test.ts",
  ]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (!result.ok) process.exit(1);
} else if (mode === "--dry-run" || mode === "--apply") {
  console.log(JSON.stringify({ status: "NOOP", reason: "B2 is implemented in tracked TypeScript source; run npm run build to emit dist." }, null, 2));
} else {
  console.error("Usage: node scripts/patch-wecom-long-message.mjs [--check|--self-test|--dry-run|--apply]");
  process.exit(2);
}
