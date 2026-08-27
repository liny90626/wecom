/**
 * Author: YanHaidao
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { registerWecomCalendarTools } from "./src/capability/calendar/tool.js";
import {
  CLI_TOOL_NAME,
  createWeComCliToolFactory,
  prewarmWecomCliCredentials,
} from "./src/capability/cli/index.js";
import { registerWecomDocTools } from "./src/capability/doc/tool.js";
import { createWeComMcpToolFactory } from "./src/capability/mcp/index.js";
import { wecomPlugin } from "./src/channel.js";
import { handleWecomWebhookRequest } from "./src/monitor.js";
import { setWecomRuntime } from "./src/runtime.js";
import { isWecomBotWsSource } from "./src/runtime/source-registry.js";

const WECOM_BOT_WS_MEDIA_GUIDANCE = [
  "【WeCom Bot WS 媒体发送】",
  "当前会话支持企业微信 Bot WS 媒体发送。",
  "当你需要发送图片、文件、视频或语音时，必须在回复中单独一行使用 MEDIA: 指令，后面跟本地文件路径。",
  "格式：MEDIA: /文件的绝对路径",
  "示例：",
  "  MEDIA: ~/.openclaw/output.png",
  "  MEDIA: ~/.openclaw/report.pdf",
  "注意事项：",
  "- MEDIA: 必须单独成行并以 MEDIA: 开头",
  "- 建议优先使用本地可访问路径，而不是远程 URL",
  "- 图片和视频超过 10MB、语音超过 2MB、文件超过 20MB 时可能会降级或发送失败",
  "- 语音消息仅原生支持 AMR；其他音频格式会按文件发送",
].join("\n");

const WECOM_CLI_GUIDANCE = [
  "企业微信通讯录、文档、会议、日程、待办、智能表格等能力必须通过专用 `wecom-cli` tool 调用。",
  "禁止通过 exec、bash、shell、npx 或 PATH 上的全局命令运行 wecom-cli；专用 tool 会按当前会话账号注入隔离凭据。",
  "调用时 args 只传 wecom-cli 后面的参数，不传命令前缀、WECOM_CLI_* 环境变量、--config-dir 或 --home。",
  "工具失败时不要降级到 exec，也不要手动执行 auth init；应报告工具权限或 channels.wecom 配置问题。",
].join("\n");

const plugin = {
  id: "wecom",
  name: "WeCom (企业微信)",
  description: "企业微信官方推荐三方插件，默认 Bot WS，支持主动发消息与统一运行时能力",
  configSchema: emptyPluginConfigSchema(),
  /**
   * **register (注册插件)**
   *
   * OpenClaw 插件入口点。
   * 1. 注入统一 runtime compatibility layer。
   * 2. 注册 capability-first WeCom 渠道插件。
   * 3. 注册统一 HTTP 入口（所有 webhook 请求都走共享路由器）。
   */
  register(api: OpenClawPluginApi) {
    setWecomRuntime(api.runtime);
    api.registerChannel({ plugin: wecomPlugin });
    const routes = ["/plugins/wecom", "/wecom"];
    for (const path of routes) {
      api.registerHttpRoute({
        path,
        handler: handleWecomWebhookRequest,
        auth: "plugin",
        match: "prefix",
      });
    }

    // Register WeCom Doc Tools
    registerWecomDocTools(api);
    registerWecomCalendarTools(api);
    api.registerTool(createWeComMcpToolFactory(), { name: "wecom_mcp" });
    api.registerTool(createWeComCliToolFactory(), { name: CLI_TOOL_NAME });

    // Authorization is warmed independently from the first business call. A
    // failed warmup is logged and left for the tool to report on demand.
    if (typeof api.registerService === "function") {
      let prewarmPromise: Promise<void> | undefined;
      api.registerService({
        id: "wecom-cli-credentials",
        start: (ctx) => {
          prewarmPromise = prewarmWecomCliCredentials(ctx.config, {
            info: (message) => ctx.logger.info(message),
            warn: (message) => ctx.logger.warn(message),
          }).catch((error) => {
            ctx.logger.warn(
              `[wecom-cli] 启动预热未完成（不影响现有渠道）：${error instanceof Error ? error.message : String(error)}`,
            );
          });
        },
        stop: async () => {
          await prewarmPromise;
        },
      });
    }

    api.on("before_prompt_build", (_event, ctx) => {
      if (ctx.channelId !== "wecom") {
        return;
      }
      if (
        !isWecomBotWsSource({
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
        })
      ) {
        return;
      }
      return {
        appendSystemContext: WECOM_BOT_WS_MEDIA_GUIDANCE,
      };
    });

    api.on("before_prompt_build", (_event, ctx) => {
      if (ctx.channelId !== "wecom") return;
      return { appendSystemContext: WECOM_CLI_GUIDANCE };
    });
  },
};

export default plugin;
