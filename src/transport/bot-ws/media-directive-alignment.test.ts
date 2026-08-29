/**
 * OpenClaw hands the transport two different shapes of the same answer: block
 * replies keep their `MEDIA:` directives (`extractMediaDirectives: false`),
 * while the final has them stripped AND its blank lines collapsed. Every shape
 * where the plugin cannot line those two up costs the user the whole answer a
 * second time, so the fixture below is not hand-written: `coreFinal` and
 * `mediaUrls` are what the core's own `splitMediaFromOutput` returns for `raw`.
 *
 * To regenerate after an OpenClaw upgrade, export `splitMediaFromOutput` from a
 * copy of `node_modules/openclaw/dist/payloads-*.js` and re-run each `raw`.
 * Captured against openclaw 2026.7.1-2.
 */
import type { WSClient } from "@wecom/aibot-node-sdk";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { __resetBotWsReplyTestState, createBotWsReplyHandle } from "./reply.js";

vi.mock("./media.js", () => ({
  uploadAndSendBotWsMedia: vi.fn(async () => ({ ok: true, messageId: "m" })),
}));
vi.setConfig({ testTimeout: 60_000 });

const CASES = [
  {"name": "tail-win-path", "raw": "答案。\n\n第二段。\n\nMEDIA:C:\\Users\\me\\report.md", "coreFinal": "答案。\n第二段。", "mediaUrls": ["C:\\Users\\me\\report.md"]},
  {"name": "mid-win-path", "raw": "第一段。\n\nMEDIA:C:\\Users\\me\\report.md\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["C:\\Users\\me\\report.md"]},
  {"name": "tail-posix-path", "raw": "答案。\n\n第二段。\n\nMEDIA:/tmp/a.png", "coreFinal": "答案。\n第二段。", "mediaUrls": ["/tmp/a.png"]},
  {"name": "mid-posix-path", "raw": "第一段。\n\nMEDIA:/tmp/a.png\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["/tmp/a.png"]},
  {"name": "tail-prose", "raw": "答案。\n\n第二段。\n\nMEDIA: 这是说明文字，不是附件", "coreFinal": "答案。\n\n第二段。\n\nMEDIA: 这是说明文字，不是附件", "mediaUrls": []},
  {"name": "mid-prose", "raw": "第一段。\n\nMEDIA: 这是说明文字，不是附件\n\n第二段。", "coreFinal": "第一段。\n\nMEDIA: 这是说明文字，不是附件\n\n第二段。", "mediaUrls": []},
  {"name": "tail-https-prose", "raw": "答案。\n\n第二段。\n\nMEDIA: https://example.com/a.png 请查收", "coreFinal": "答案。\n第二段。\n请查收", "mediaUrls": ["https://example.com/a.png"]},
  {"name": "mid-https-prose", "raw": "第一段。\n\nMEDIA: https://example.com/a.png 请查收\n\n第二段。", "coreFinal": "第一段。\n请查收\n第二段。", "mediaUrls": ["https://example.com/a.png"]},
  {"name": "tail-two-paths-prose", "raw": "答案。\n\n第二段。\n\nMEDIA:/a/1.png /b/2.png 见附件", "coreFinal": "答案。\n第二段。\n见附件", "mediaUrls": ["/a/1.png", "/b/2.png"]},
  {"name": "mid-two-paths-prose", "raw": "第一段。\n\nMEDIA:/a/1.png /b/2.png 见附件\n\n第二段。", "coreFinal": "第一段。\n见附件\n第二段。", "mediaUrls": ["/a/1.png", "/b/2.png"]},
  {"name": "tail-prose-path-prose", "raw": "答案。\n\n第二段。\n\nMEDIA: 详见 /tmp/a.png 谢谢", "coreFinal": "答案。\n第二段。", "mediaUrls": ["详见 /tmp/a.png 谢谢"]},
  {"name": "mid-prose-path-prose", "raw": "第一段。\n\nMEDIA: 详见 /tmp/a.png 谢谢\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["详见 /tmp/a.png 谢谢"]},
  {"name": "tail-two-paths-mid-prose", "raw": "答案。\n\n第二段。\n\nMEDIA: 见 /tmp/a.png 与 /tmp/b.png 的对比", "coreFinal": "答案。\n第二段。\n见 与 的对比", "mediaUrls": ["/tmp/a.png", "/tmp/b.png"]},
  {"name": "mid-two-paths-mid-prose", "raw": "第一段。\n\nMEDIA: 见 /tmp/a.png 与 /tmp/b.png 的对比\n\n第二段。", "coreFinal": "第一段。\n见 与 的对比\n第二段。", "mediaUrls": ["/tmp/a.png", "/tmp/b.png"]},
  {"name": "tail-long-ext", "raw": "答案。\n\n第二段。\n\nMEDIA: 报告.markdown", "coreFinal": "答案。\n第二段。", "mediaUrls": ["报告.markdown"]},
  {"name": "mid-long-ext", "raw": "第一段。\n\nMEDIA: 报告.markdown\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["报告.markdown"]},
  {"name": "tail-http-url", "raw": "答案。\n\n第二段。\n\nMEDIA:http://example.com/a.png", "coreFinal": "答案。\n\n第二段。\n\nMEDIA:http://example.com/a.png", "mediaUrls": []},
  {"name": "mid-http-url", "raw": "第一段。\n\nMEDIA:http://example.com/a.png\n\n第二段。", "coreFinal": "第一段。\n\nMEDIA:http://example.com/a.png\n\n第二段。", "mediaUrls": []},
  {"name": "tail-https-localhost", "raw": "答案。\n\n第二段。\n\nMEDIA:https://localhost:3000/a.png", "coreFinal": "答案。\n\n第二段。\n\nMEDIA:https://localhost:3000/a.png", "mediaUrls": []},
  {"name": "mid-https-localhost", "raw": "第一段。\n\nMEDIA:https://localhost:3000/a.png\n\n第二段。", "coreFinal": "第一段。\n\nMEDIA:https://localhost:3000/a.png\n\n第二段。", "mediaUrls": []},
  {"name": "tail-file-url", "raw": "答案。\n\n第二段。\n\nMEDIA:file:///tmp/a.png", "coreFinal": "答案。\n第二段。", "mediaUrls": ["/tmp/a.png"]},
  {"name": "mid-file-url", "raw": "第一段。\n\nMEDIA:file:///tmp/a.png\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["/tmp/a.png"]},
  {"name": "tail-traversal", "raw": "答案。\n\n第二段。\n\nMEDIA:../out/report.png", "coreFinal": "答案。\n第二段。", "mediaUrls": []},
  {"name": "mid-traversal", "raw": "第一段。\n\nMEDIA:../out/report.png\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": []},
  {"name": "tail-traversal-mid", "raw": "答案。\n\n第二段。\n\nMEDIA:/a/../b.png", "coreFinal": "答案。\n第二段。", "mediaUrls": []},
  {"name": "mid-traversal-mid", "raw": "第一段。\n\nMEDIA:/a/../b.png\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": []},
  {"name": "tail-quoted-spaces", "raw": "答案。\n\n第二段。\n\nMEDIA:\"C:\\Users\\me\\my report.md\"", "coreFinal": "答案。\n第二段。", "mediaUrls": ["C:\\Users\\me\\my report.md"]},
  {"name": "mid-quoted-spaces", "raw": "第一段。\n\nMEDIA:\"C:\\Users\\me\\my report.md\"\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["C:\\Users\\me\\my report.md"]},
  {"name": "tail-bare-filename", "raw": "答案。\n\n第二段。\n\nMEDIA: report.pdf", "coreFinal": "答案。\n第二段。", "mediaUrls": ["report.pdf"]},
  {"name": "mid-bare-filename", "raw": "第一段。\n\nMEDIA: report.pdf\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["report.pdf"]},
  {"name": "tail-spaced-bare", "raw": "答案。\n\n第二段。\n\nMEDIA: 版本 2.5", "coreFinal": "答案。\n第二段。", "mediaUrls": ["版本 2.5"]},
  {"name": "mid-spaced-bare", "raw": "第一段。\n\nMEDIA: 版本 2.5\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["版本 2.5"]},
  {"name": "tail-spaced-filename", "raw": "答案。\n\n第二段。\n\nMEDIA: 设计稿 v2.png", "coreFinal": "答案。\n第二段。", "mediaUrls": ["设计稿 v2.png"]},
  {"name": "mid-spaced-filename", "raw": "第一段。\n\nMEDIA: 设计稿 v2.png\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["设计稿 v2.png"]},
  {"name": "tail-prose-filename", "raw": "答案。\n\n第二段。\n\nMEDIA: 结果见 report.pdf", "coreFinal": "答案。\n第二段。", "mediaUrls": ["结果见 report.pdf"]},
  {"name": "mid-prose-filename", "raw": "第一段。\n\nMEDIA: 结果见 report.pdf\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["结果见 report.pdf"]},
  {"name": "tail-english-spaced-file", "raw": "答案。\n\n第二段。\n\nMEDIA: final report.pdf", "coreFinal": "答案。\n第二段。", "mediaUrls": ["final report.pdf"]},
  {"name": "mid-english-spaced-file", "raw": "第一段。\n\nMEDIA: final report.pdf\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["final report.pdf"]},
  {"name": "tail-tilde-path", "raw": "答案。\n\n第二段。\n\nMEDIA: ~/out/a.png", "coreFinal": "答案。\n第二段。", "mediaUrls": ["~/out/a.png"]},
  {"name": "mid-tilde-path", "raw": "第一段。\n\nMEDIA: ~/out/a.png\n\n第二段。", "coreFinal": "第一段。\n第二段。", "mediaUrls": ["~/out/a.png"]},
  {"name": "fenced", "raw": "用法：\n\n```\nMEDIA:/tmp/a.png\n```\n\n结束。", "coreFinal": "用法：\n\n```\nMEDIA:/tmp/a.png\n```\n\n结束。", "mediaUrls": []},
  {"name": "fence-inner-tilde", "raw": "答案。\n\n```js\n~~~\ncode\n```\n\nMEDIA:/tmp/a.png\n\n第二段。", "coreFinal": "答案。\n```js\n~~~\ncode\n```\n第二段。", "mediaUrls": ["/tmp/a.png"]},
  {"name": "fence-inner-backtick", "raw": "答案。\n\n~~~md\n```\ncode\n~~~\n\nMEDIA:/tmp/a.png\n\n第二段。", "coreFinal": "答案。\n~~~md\n```\ncode\n~~~\n第二段。", "mediaUrls": ["/tmp/a.png"]},
  {"name": "fence-inner-short", "raw": "答案。\n\n````md\n```\ncode\n````\n\nMEDIA:/tmp/a.png\n\n第二段。", "coreFinal": "答案。\n````md\n```\ncode\n````\n第二段。", "mediaUrls": ["/tmp/a.png"]},
  {"name": "fence-unclosed", "raw": "答案。\n\n```\ncode\n\nMEDIA:/tmp/a.png", "coreFinal": "答案。\n\n```\ncode\n\nMEDIA:/tmp/a.png", "mediaUrls": []},
  {"name": "two-directives", "raw": "答案。\n\nMEDIA:/tmp/a.png\nMEDIA:/tmp/b.png\n\n第二段。", "coreFinal": "答案。\n第二段。", "mediaUrls": ["/tmp/a.png", "/tmp/b.png"]},
  {"name": "directive-only", "raw": "MEDIA:/tmp/a.png", "coreFinal": "", "mediaUrls": ["/tmp/a.png"]},
] as const;

/** How the blocks arrived relative to the final — the shapes that broke before:
 *  one block covering the answer, a producer re-sending as it grows, and blocks
 *  that stop short of what the final carries. */
const MODES = ["single", "cumulative", "lagging"] as const;

const squeeze = (value: string): string => value.replace(/\s+/g, "");
const FENCE_LINE_RE = /^ {0,3}(?:`{3,}|~{3,})/;
const DIRECTIVE_LINE_RE = /^[^\S\n]*MEDIA:/i;

describe("plugin block text vs the core's own final", () => {
  let mockClient: import("vitest").Mocked<WSClient>;

  beforeEach(async () => {
    vi.useFakeTimers();
    __resetBotWsReplyTestState();
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/wecom-diff-state");
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({ config: { loadConfig: () => ({}) } } as never);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("never duplicates or swallows a paragraph, for any directive shape", async () => {
    const bad: string[] = [];
    for (const testCase of CASES) {
      for (const mode of MODES) {
        __resetBotWsReplyTestState();
        mockClient = {
          replyStream: vi.fn().mockResolvedValue({}),
          sendMessage: vi.fn().mockResolvedValue({}),
          replyWelcome: vi.fn().mockResolvedValue({}),
        } as unknown as import("vitest").Mocked<WSClient>;
        const handle = createBotWsReplyHandle({
          client: mockClient,
          frame: {
            headers: { req_id: `req-${testCase.name}-${mode}` },
            body: { from: { userid: "alice" }, chattype: "single" },
          } as never,
          accountId: "default",
          inboundKind: "text",
          autoSendPlaceholder: false,
        });

        const breakAt = testCase.raw.indexOf("\n\n");
        const head = breakAt > 0 ? testCase.raw.slice(0, breakAt) : testCase.raw;
        if (mode !== "single") {
          await handle.deliver({ text: head }, { kind: "block" });
        }
        if (mode !== "lagging") {
          await handle.deliver({ text: testCase.raw }, { kind: "block" });
        }
        await handle.deliver(
          {
            text: testCase.coreFinal,
            ...(testCase.mediaUrls.length > 0 ? { mediaUrls: [...testCase.mediaUrls] } : {}),
          },
          { kind: "final" },
        );

        const calls = (mockClient.replyStream as never as { mock: { calls: unknown[][] } }).mock
          .calls;
        const last = String(calls.at(-1)?.[2] ?? "");
        const where = `${testCase.name}/${mode}`;
        // Every line of the answer the core did not take must still be there.
        // Without this an over-eager strip is invisible: it deletes the line
        // from the block AND from the core's final, so the two still agree.
        for (const line of testCase.raw.split("\n")) {
          const text = line.trim();
          if (!text || DIRECTIVE_LINE_RE.test(line) || FENCE_LINE_RE.test(line)) {
            continue;
          }
          if (!squeeze(last).includes(squeeze(text))) {
            bad.push(`${where}: LOST ${JSON.stringify(text)} :: ${JSON.stringify(last)}`);
          }
          const occurrences = squeeze(last).split(squeeze(text)).length - 1;
          if (occurrences > 1) {
            bad.push(`${where}: ${JSON.stringify(text)} x${occurrences} :: ${JSON.stringify(last)}`);
          }
        }
        if (last.includes("MEDIA:") && !testCase.coreFinal.includes("MEDIA:")) {
          bad.push(`${where}: leaked MEDIA :: ${JSON.stringify(last)}`);
        }
      }
    }
    for (const entry of bad) console.log("BAD " + entry);
    console.log(`DIFFERENTIAL cases=${CASES.length} runs=${CASES.length * MODES.length} bad=${bad.length}`);
    expect(bad).toEqual([]);
  });
});
