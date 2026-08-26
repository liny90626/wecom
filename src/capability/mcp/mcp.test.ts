import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({
  replyCommand: vi.fn(),
  isConnected: vi.fn(() => true),
  cfg: {} as Record<string, unknown>,
  mcpServers: undefined as Record<string, string> | undefined,
}));

const sourceMock = vi.hoisted(() => ({
  snapshot: {
    source: "bot-ws",
    requesterUserId: "ZhangSan",
    chatId: "wrABCDefGH",
    peerKind: "group",
  } as Record<string, unknown> | null,
}));

const httpMock = vi.hoisted(() => ({
  queue: [] as unknown[],
  calls: [] as Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>,
}));

vi.mock("../../runtime.js", () => ({
  getBotWsPushHandle: () => ({
    isConnected: runtimeMock.isConnected,
    replyCommand: runtimeMock.replyCommand,
  }),
  getWecomRuntime: () => ({ config: { loadConfig: () => runtimeMock.cfg } }),
}));

vi.mock("../../config/accounts.js", () => ({
  resolveWecomAccount: () => ({
    bot: { config: { mcpServers: runtimeMock.mcpServers } },
  }),
}));

vi.mock("../../runtime/source-registry.js", () => ({
  resolveWecomSourceSnapshot: () => sourceMock.snapshot,
}));

vi.mock("@wecom/aibot-node-sdk", () => ({
  generateReqId: (prefix: string) => `${prefix}-1`,
}));

vi.mock("undici", () => ({
  fetch: vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    httpMock.calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const next = httpMock.queue.shift();
    if (next === undefined) throw new Error("unexpected extra fetch");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      // 不返回 mcp-session-id ⇒ 走 stateless 分支，省掉 initialized 通知。
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", result: next }),
    };
  }),
}));

import { createWeComMcpToolFactory } from "./tool.js";
import { clearWecomMcpAccountCache } from "./transport.js";
import { PLUGIN_VERSION } from "../../version.js";

const CONFIG_URL = "https://mcp.example.com/stream/abc?token=SUPER_SECRET_TOKEN";

/** 企微把业务错误装在成功的 MCP 结果里。 */
const bizError = (errcode: number, errmsg: string, extra: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: JSON.stringify({ errcode, errmsg, ...extra }) }],
});

const okResult = (text: string) => ({ content: [{ type: "text", text }] });

/** 冷启动一次调用要两次 HTTP：initialize + 真正的请求。 */
function queueCall(result: unknown): void {
  httpMock.queue.push({ protocolVersion: "2025-03-26" }, result);
}

let ctxOverrides: { requesterSenderId?: string } = {};

async function runTool(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = createWeComMcpToolFactory()({
    messageChannel: "wecom",
    accountId: "acc-1",
    sessionKey: "s",
    sessionId: "s",
    ...(ctxOverrides.requesterSenderId === undefined
      ? {}
      : { requesterSenderId: ctxOverrides.requesterSenderId }),
  } as never);
  if (!tool) throw new Error("tool factory returned null");
  const result = (await tool.execute("call-1", params)) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

/**
 * 拆出 MCP result 里那层内嵌 JSON：官方的授权拦截返回的仍是标准
 * `{content:[{type:"text",text:"<json>"}]}` 形态，业务字段在 text 里。
 */
function innerJson(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content as Array<{ text?: string }> | undefined;
  const text = content?.[0]?.text;
  return text ? (JSON.parse(text) as Record<string, unknown>) : result;
}

const bizMsgCalls = () =>
  runtimeMock.replyCommand.mock.calls
    .map((call) => call[0] as { cmd: string; body: Record<string, unknown> })
    .filter((req) => req.cmd === "aibot_send_biz_msg");

describe("wecom_mcp", () => {
  beforeEach(() => {
    httpMock.queue.length = 0;
    httpMock.calls.length = 0;
    clearWecomMcpAccountCache("acc-1");
    sourceMock.snapshot = {
      source: "bot-ws",
      requesterUserId: "ZhangSan",
      chatId: "wrABCDefGH",
      peerKind: "group",
    };
    runtimeMock.isConnected.mockReturnValue(true);
    runtimeMock.replyCommand.mockReset();
    runtimeMock.replyCommand.mockResolvedValue({ errcode: 0, body: { url: CONFIG_URL } });
    runtimeMock.mcpServers = undefined;
    ctxOverrides = { requesterSenderId: "ZhangSan" };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearWecomMcpAccountCache("acc-1");
  });

  describe("请求身份（官方 x-openclaw-wecom-userid）", () => {
    it("每一次 MCP 请求都带上发起人 userid——握手与调用都要带", async () => {
      queueCall(okResult("ok"));
      await runTool({ action: "call", category: "doc", method: "doc_create", args: "{}" });

      expect(httpMock.calls).toHaveLength(2);
      for (const call of httpMock.calls) {
        // MCP 平面是「代替成员」操作的：不带身份，服务端只会回 no authority。
        expect(call.headers["x-openclaw-wecom-userid"]).toBe("ZhangSan");
      }
    });

    it("userid 保持原始大小写", async () => {
      queueCall({ tools: [] });
      await runTool({ action: "list", category: "contact" });

      expect(httpMock.calls[0]?.headers["x-openclaw-wecom-userid"]).toBe("ZhangSan");
      expect(httpMock.calls[0]?.headers["x-openclaw-wecom-userid"]).not.toBe("zhangsan");
    });

    it("拿不到发起人时不带该 header，而不是发一个空值", async () => {
      ctxOverrides = {};
      sourceMock.snapshot = { source: "bot-ws" };
      queueCall(okResult("ok"));
      await runTool({ action: "call", category: "doc", method: "doc_create", args: "{}" });

      expect(httpMock.calls[0]?.headers).not.toHaveProperty("x-openclaw-wecom-userid");
    });

    it("身份优先取 OpenClaw core 的 requesterSenderId（官方来源）", async () => {
      // core 标注它是 trusted sender id；我们自己 registry 里那份只作兜底。
      ctxOverrides = { requesterSenderId: "CoreTrustedId" };
      sourceMock.snapshot = {
        source: "bot-ws",
        requesterUserId: "StaleRegistryId",
        chatId: "wrABCDefGH",
        peerKind: "group",
      };
      queueCall(okResult("ok"));
      await runTool({ action: "call", category: "doc", method: "doc_create", args: "{}" });

      expect(httpMock.calls[0]?.headers["x-openclaw-wecom-userid"]).toBe("CoreTrustedId");
    });

    it("core 没给时回落到入站记录里的原文 userid", async () => {
      ctxOverrides = {};
      queueCall(okResult("ok"));
      await runTool({ action: "call", category: "doc", method: "doc_create", args: "{}" });

      expect(httpMock.calls[0]?.headers["x-openclaw-wecom-userid"]).toBe("ZhangSan");
    });

    it("带上官方形态的 User-Agent", async () => {
      queueCall(okResult("ok"));
      await runTool({ action: "call", category: "doc", method: "doc_create", args: "{}" });

      expect(httpMock.calls[0]?.headers["User-Agent"]).toMatch(
        /^OpenClawPlugin\/\d[\w.-]* \w+\/\w+$/,
      );
    });
  });

  it("category 原样发给企微，不做任何改写（对齐官方）", async () => {
    queueCall(okResult("ok"));
    await runTool({ action: "call", category: "smartsheet", method: "x", args: "{}" });

    const config = runtimeMock.replyCommand.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(config.body.biz_type).toBe("smartsheet");
  });

  it("日志不带出配置 URL 里的凭证", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    queueCall(okResult("ok"));
    await runTool({ action: "call", category: "doc", method: "doc_create", args: "{}" });

    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("https://mcp.example.com/stream/abc");
    expect(logged).not.toContain("SUPER_SECRET_TOKEN");
  });

  describe("业务错误码（对齐官方集合）", () => {
    it.each([850001, 851014])("%i 作废配置与会话，下次调用重新拉取", async (errcode) => {
      queueCall(bizError(errcode, "auth expired"));
      await runTool({ action: "call", category: "contact", method: "contact_users_search", args: "{}" });

      queueCall(okResult("ok"));
      await runTool({ action: "call", category: "contact", method: "contact_users_search", args: "{}" });

      const configFetches = runtimeMock.replyCommand.mock.calls.filter(
        (call) => (call[0] as { cmd: string }).cmd === "aibot_get_mcp_config",
      );
      expect(configFetches).toHaveLength(2);
    });

    it("其它业务错误码不动缓存，也不改写返回", async () => {
      queueCall(bizError(40058, "invalid parameter"));
      const parsed = await runTool({
        action: "call",
        category: "contact",
        method: "contact_users_search",
        args: "{}",
      });

      expect(JSON.stringify(parsed)).toContain("invalid parameter");
      expect(bizMsgCalls()).toHaveLength(0);
    });
  });

  describe("文档授权引导卡片", () => {
    it.each([851013, 851014, 851008])(
      "doc 品类命中 %i：推授权卡片，并拦下 help_message",
      async (errcode) => {
        queueCall(
          bizError(errcode, "no doc authority", {
            help_message: "请打开链接 https://example.com/auth 完成授权",
          }),
        );

        const parsed = await runTool({
          action: "call",
          category: "doc",
          method: "doc_contents_append",
          args: "{}",
        });

        const cards = bizMsgCalls();
        expect(cards).toHaveLength(1);
        expect(cards[0]?.body).toMatchObject({
          biz_type: 1,
          chat_id: "wrABCDefGH",
          chat_type: 2,
          userid: "ZhangSan",
        });
        const inner = innerJson(parsed);
        expect(inner._biz_msg_sent).toBe(true);
        expect(inner.errcode).toBe(errcode);
        // 授权步骤由卡片承担，转述只会走样。
        // 企微用 help_instruction 明确要求 help_message 逐字原样展示给用户，
        // 官方 2026.7.2 的拦截器把它丢掉了——那版代码早于这个字段。
        expect(inner.help_message).toBe("请打开链接 https://example.com/auth 完成授权");
      },
    );

    it("chat_id 与 userid 必须是原文大小写（小写会被企微判为 93006）", async () => {
      queueCall(bizError(851013, "no doc authority"));
      await runTool({ action: "call", category: "doc", method: "doc_create", args: "{}" });

      const body = bizMsgCalls()[0]?.body as Record<string, unknown>;
      expect(body.chat_id).toBe("wrABCDefGH");
      expect(body.userid).toBe("ZhangSan");
    });

    it("单聊按 chat_type=1 发", async () => {
      sourceMock.snapshot = {
        source: "bot-ws",
        requesterUserId: "LiSi",
        chatId: "LiSi",
        peerKind: "direct",
      };
      queueCall(bizError(851013, "no doc authority"));
      await runTool({ action: "call", category: "doc", method: "doc_create", args: "{}" });

      expect(bizMsgCalls()[0]?.body).toMatchObject({ chat_type: 1, chat_id: "LiSi" });
    });

    it("非 doc 品类的同码错误不推卡片", async () => {
      queueCall(bizError(851013, "no authority"));
      const parsed = await runTool({
        action: "call",
        category: "contact",
        method: "contact_users_search",
        args: "{}",
      });

      expect(bizMsgCalls()).toHaveLength(0);
      expect(innerJson(parsed)._biz_msg_sent).toBeUndefined();
    });

    it("缺会话上下文时不推卡片，但仍要告诉用户去哪里重新授权", async () => {
      sourceMock.snapshot = { source: "bot-ws", requesterUserId: "ZhangSan" };
      queueCall(bizError(851013, "no doc authority"));

      const parsed = await runTool({
        action: "call",
        category: "doc",
        method: "doc_create",
        args: "{}",
      });

      expect(bizMsgCalls()).toHaveLength(0);
      const inner = innerJson(parsed);
      expect(inner._biz_msg_sent).toBe(false);
      expect(String(inner._user_hint)).toContain("重新授权");
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

      expect(parsed.count).toBe(2);
      expect(parsed.truncated).toBeUndefined();
      expect(JSON.stringify(parsed)).toContain("inputSchema");
    });

    it("清单再大也照原样给出完整 schema——现网 19 个工具就会被限幅误伤", async () => {
      // 官方没有上限。我曾加过 32KB 限幅，结果现网只有 19 个工具就触发，
      // 模型因此拿不到 inputSchema、只能猜参数名。
      queueCall({ tools: Array.from({ length: 60 }, (_, i) => tool(`smartsheet_tool_${i}`, 12)) });
      const parsed = await runTool({ action: "list", category: "doc" });

      expect(parsed.count).toBe(60);
      expect(parsed.truncated).toBeUndefined();
      expect(JSON.stringify(parsed)).toContain("inputSchema");
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
    expect(httpMock.calls).toHaveLength(0);
  });

  it("缺少 category 时不去问企微", async () => {
    const parsed = await runTool({ action: "list", category: "  " });

    expect(String(parsed.error)).toContain("category");
    expect(runtimeMock.replyCommand).not.toHaveBeenCalled();
    expect(httpMock.calls).toHaveLength(0);
  });

  it("鉴权初始化的两个版本字段与官方语义一致", async () => {
    // aibot_get_mcp_config 是签发授权 URL 的那次调用：官方发插件真实版本号，
    // 我们此前发的是魔法串 "wecom-dual-plane"（根本不是版本号）。
    // initialize 的 clientInfo 官方硬编码 "1.0.0"，与 plugin_version 是两个值。
    queueCall(okResult("ok"));
    await runTool({ action: "call", category: "doc", method: "doc_create", args: "{}" });

    const config = runtimeMock.replyCommand.mock.calls[0]?.[0] as {
      body: Record<string, unknown>;
    };
    expect(config.body.plugin_version).toBe(PLUGIN_VERSION);
    expect(config.body.plugin_version).not.toBe("wecom-dual-plane");

    const init = httpMock.calls[0]?.body as {
      method: string;
      params: { clientInfo: { name: string; version: string } };
    };
    expect(init.method).toBe("initialize");
    expect(init.params.clientInfo).toEqual({ name: "wecom_mcp", version: "1.0.0" });
  });

  describe("显式配置的 MCP Server 地址", () => {
    // 官方文档列出的两种接入方式之一：后台「查看使用方式」复制的 streamableHTTP
    // URL，其 apikey 是成员完成授权后才签发的，成员的文档权限随它共享给使用者。
    const CONSOLE_URL =
      "https://qyapi.weixin.qq.com/mcp/v2/bot/doc?apikey=CONSOLE_ISSUED_KEY";

    it("配了就直接用它，不再向企微要配置", async () => {
      runtimeMock.mcpServers = { doc: CONSOLE_URL };
      queueCall(okResult("ok"));

      await runTool({ action: "call", category: "doc", method: "sheet_get_info", args: "{}" });

      expect(runtimeMock.replyCommand).not.toHaveBeenCalled();
      expect(httpMock.calls[0]?.url).toBe(CONSOLE_URL);
      expect(httpMock.calls[1]?.url).toBe(CONSOLE_URL);
    });

    it("只覆盖配了的品类，其余仍走 aibot_get_mcp_config", async () => {
      runtimeMock.mcpServers = { doc: CONSOLE_URL };
      queueCall({ tools: [] });

      await runTool({ action: "list", category: "contact" });

      expect(runtimeMock.replyCommand).toHaveBeenCalledTimes(1);
      expect(httpMock.calls[0]?.url).toBe(CONFIG_URL);
    });

    it("身份 header 照常带上", async () => {
      runtimeMock.mcpServers = { doc: CONSOLE_URL };
      queueCall(okResult("ok"));

      await runTool({ action: "call", category: "doc", method: "sheet_get_info", args: "{}" });

      expect(httpMock.calls[0]?.headers["x-openclaw-wecom-userid"]).toBe("ZhangSan");
    });

    it("日志不带出 apikey", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      runtimeMock.mcpServers = { doc: CONSOLE_URL };
      queueCall(okResult("ok"));

      await runTool({ action: "call", category: "doc", method: "sheet_get_info", args: "{}" });

      const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("https://qyapi.weixin.qq.com/mcp/v2/bot/doc");
      expect(logged).not.toContain("CONSOLE_ISSUED_KEY");
    });
  });
});
