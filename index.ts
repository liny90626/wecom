/**
 * Author: YanHaidao
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { registerWecomCalendarTools } from "./src/capability/calendar/tool.js";
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
  },
};

export default plugin;
