import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({
  replyCommand: vi.fn(),
  isConnected: vi.fn(() => true),
}));

vi.mock("../../runtime.js", () => ({
  getBotWsPushHandle: () => ({
    isConnected: runtimeMock.isConnected,
    replyCommand: runtimeMock.replyCommand,
  }),
}));

vi.mock("../../runtime/source-registry.js", () => ({
  resolveWecomSourceSnapshot: () => ({ source: "bot-ws" }),
}));

vi.mock("@wecom/aibot-node-sdk", () => ({
  generateReqId: (prefix: string) => `${prefix}-1`,
}));

import { createWeComMcpToolFactory } from "./tool.js";
import {
  clearWecomMcpAccountCache,
  resolveWecomMcpBizType,
  sendJsonRpc,
} from "./transport.js";

const CONFIG_URL = "https://mcp.example.com/stream/abc?token=SUPER_SECRET_TOKEN";

/** 队列化的 MCP HTTP 应答：每次 fetch 取一条。 */
const httpQueue: unknown[] = [];
const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

function jsonResponse(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    // 没有 mcp-session-id ⇒ 走 stateless 分支，省掉一次 initialized 通知。
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", result }),
  } as unknown as Response;
}

/** 企微把业务错误装在成功的 MCP 结果里。 */
function bizErrorResult(errcode: number, errmsg: string): unknown {
  return { content: [{ type: "text", text: JSON.stringify({ errcode, errmsg }) }] };
}

function okResult(text: string): unknown {
  return { content: [{ type: "text", text }] };
}

function queueCall(result: unknown): void {
  // 每次 sendJsonRpc 冷启动要两次 HTTP：initialize + 真正的调用。
  httpQueue.push({ protocolVersion: "2025-03-26" }, result);
}

function buildTool() {
  const tool = createWeComMcpToolFactory()({
    messageChannel: "wecom",
    accountId: "acc-1",
    sessionKey: "s",
    sessionId: "s",
  } as never);
  if (!tool) throw new Error("tool factory returned null");
  return tool;
}

async function runTool(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await buildTool().execute("call-1", params)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("wecom_mcp", () => {
  beforeEach(() => {
    httpQueue.length = 0;
    fetchCalls.length = 0;
    clearWecomMcpAccountCache("acc-1");
    runtimeMock.isConnected.mockReturnValue(true);
    runtimeMock.replyCommand.mockReset();
    runtimeMock.replyCommand.mockResolvedValue({ errcode: 0, body: { url: CONFIG_URL } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        const next = httpQueue.shift();
        if (next === undefined) throw new Error("unexpected extra fetch");
        return jsonResponse(next);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearWecomMcpAccountCache("acc-1");
  });

  describe("biz_type 归一", () => {
    // 官方取值表（CLI 概述 doc 61944）：能力名与 biz_type 并不同名，靠猜必错。
    it.each([
      ["doc", "doc"],
      ["smartsheet", "doc"],
      ["smart_sheet", "doc"],
      ["sheet", "doc"],
      ["smartpage", "doc"],
      ["智能表格", "doc"],
      ["智能文档", "doc"],
      ["wedoc", "doc"],
      ["calendar", "schedule"],
      ["schedule", "schedule"],
      ["message", "msg"],
      ["msg", "msg"],
      ["email", "mail"],
      ["drive", "disk"],
      ["contacts", "contact"],
      ["MeetingS", "meeting"],
    ])("把 %s 归一到 %s", (input, expected) => {
      expect(resolveWecomMcpBizType(input)).toEqual({ bizType: expected, recognized: true });
    });

    it("认不出的取值原样放行，不写死枚举把未来品类挡在门外", () => {
      expect(resolveWecomMcpBizType("brand_new_thing")).toEqual({
        bizType: "brand_new_thing",
        recognized: false,
      });
    });
  });

  it("按官方取值表发出 biz_type，而不是模型给的能力名", async () => {
    queueCall(okResult("ok"));
    await sendJsonRpc("acc-1", "smartsheet", "tools/call", { name: "smartsheet_records_list" });

    expect(runtimeMock.replyCommand).toHaveBeenCalledTimes(1);
    const request = runtimeMock.replyCommand.mock.calls[0]?.[0] as {
      cmd: string;
      body: Record<string, unknown>;
    };
    expect(request.cmd).toBe("aibot_get_mcp_config");
    // 发 "smartsheet" 会拿回一个没有作用域的 URL，之后每次调用都是 851003。
    expect(request.body.biz_type).toBe("doc");
  });

  it("同一作用域的别名共用一份配置与会话，不重复取配置", async () => {
    queueCall(okResult("first"));
    await sendJsonRpc("acc-1", "smartsheet", "tools/call", { name: "a" });
    // 第二次是热路径：配置与会话都已缓存，只剩一次真正的调用。
    httpQueue.push(okResult("second"));
    await sendJsonRpc("acc-1", "doc", "tools/call", { name: "b" });

    expect(runtimeMock.replyCommand).toHaveBeenCalledTimes(1);
  });

  it("日志不带出配置 URL 里的凭证", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    queueCall(okResult("ok"));
    await sendJsonRpc("acc-1", "doc", "tools/call", { name: "a" });

    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("https://mcp.example.com/stream/abc");
    expect(logged).not.toContain("SUPER_SECRET_TOKEN");
  });

  describe("授权类错误", () => {
    it("851003 先作废配置重取一次再试，成功就不再打扰调用方", async () => {
      queueCall(bizErrorResult(851003, "no authority"));
      queueCall(okResult("成功写入"));

      const parsed = await runTool({
        action: "call",
        category: "smartsheet",
        method: "smartsheet_records_add",
        args: "{}",
      });

      // 重取配置 = 第二次 aibot_get_mcp_config。
      expect(runtimeMock.replyCommand).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(parsed)).toContain("成功写入");
      expect(parsed.hint).toBeUndefined();
    });

    it("重取后仍然 851003 就停手，并给出可执行的排查提示", async () => {
      queueCall(bizErrorResult(851003, "no authority"));
      queueCall(bizErrorResult(851003, "no authority"));

      const parsed = await runTool({
        action: "call",
        category: "smartsheet",
        method: "smartsheet_records_add",
        args: "{}",
      });

      expect(runtimeMock.replyCommand).toHaveBeenCalledTimes(2);
      const hint = String(parsed.hint ?? "");
      expect(hint).toContain("851003");
      expect(hint).toContain("7 天");
      expect(hint).toContain("Webhook");
      expect(hint).toContain("biz_type=doc");
      // 只重试一次：真没授权时再试也是同一个错误。
      expect(httpQueue).toHaveLength(0);
    });

    it("非授权类业务错误原样返回，不重试也不加提示", async () => {
      queueCall(bizErrorResult(40058, "invalid parameter"));

      const parsed = await runTool({
        action: "call",
        category: "doc",
        method: "doc_create",
        args: "{}",
      });

      expect(runtimeMock.replyCommand).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(parsed)).toContain("invalid parameter");
      expect(parsed.hint).toBeUndefined();
    });
  });

  describe("tools/list", () => {
    const tool = (name: string, schemaSize = 1) => ({
      name,
      description: `${name} 说明`,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: schemaSize }, (_, i) => [
            `field_${i}`,
            { type: "string", description: "x".repeat(80) },
          ]),
        ),
      },
    });

    it("清单放得下时给出完整 schema", async () => {
      queueCall({ tools: [tool("todo_create"), tool("todo_list")] });

      const parsed = await runTool({ action: "list", category: "todo" });

      expect(parsed.bizType).toBe("todo");
      expect(parsed.count).toBe(2);
      expect(parsed.truncated).toBeUndefined();
      expect(JSON.stringify(parsed)).toContain("inputSchema");
    });

    it("清单超预算时退回名称索引，并说明怎么取完整 schema", async () => {
      queueCall({
        tools: Array.from({ length: 60 }, (_, i) => tool(`smartsheet_tool_${i}`, 12)),
      });

      const parsed = await runTool({ action: "list", category: "doc" });

      expect(parsed.truncated).toBe(true);
      expect(parsed.count).toBe(60);
      expect(String(parsed.note)).toContain("前缀");
      expect(JSON.stringify(parsed)).not.toContain("inputSchema");
    });

    it("method 作为前缀过滤，把大品类切成能装下的一组", async () => {
      queueCall({
        tools: [
          tool("doc_create"),
          tool("sheet_create"),
          tool("smartsheet_records_add"),
          tool("smartsheet_records_update"),
        ],
      });

      const parsed = await runTool({ action: "list", category: "doc", method: "smartsheet_" });

      expect(parsed.count).toBe(2);
      expect(parsed.namePrefix).toBe("smartsheet_");
      expect(JSON.stringify(parsed)).not.toContain("doc_create");
    });
  });

  it("Bot WS 未连接时直接给出可读原因，不去打 HTTP", async () => {
    runtimeMock.isConnected.mockReturnValue(false);

    const parsed = await runTool({
      action: "call",
      category: "doc",
      method: "doc_create",
      args: "{}",
    });

    expect(String(parsed.error)).toContain("Bot WS 未连接");
    expect(fetchCalls).toHaveLength(0);
  });

  it("缺少 category 时直接给出官方取值，不去问企微", async () => {
    const parsed = await runTool({ action: "list", category: "  " });

    expect(String(parsed.error)).toContain("biz_type");
    expect(String(parsed.error)).toContain("schedule");
    expect(runtimeMock.replyCommand).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });
});
