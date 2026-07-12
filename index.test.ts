import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  clearWecomOutboundDeliveriesForTest,
  getWecomOutboundDeliverySequence,
} from "./src/runtime/outbound-delivery.js";

describe("wecom plugin register", () => {
  beforeEach(() => {
    clearWecomOutboundDeliveriesForTest();
  });
  it("registers both recommended and legacy webhook route prefixes", () => {
    const registerChannel = vi.fn();
    const registerHttpRoute = vi.fn();
    const registerTool = vi.fn();
    const on = vi.fn();
    const api = {
      runtime: {},
      registerChannel,
      registerHttpRoute,
      registerTool,
      on,
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    expect(registerChannel).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute).toHaveBeenCalledTimes(2);
    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/plugins/wecom",
        auth: "plugin",
        match: "prefix",
      }),
    );
    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/wecom",
        auth: "plugin",
        match: "prefix",
      }),
    );
  });

  it("declares registered tools in the plugin manifest contracts", () => {
    const manifestPath = path.resolve(process.cwd(), "openclaw.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    expect(manifest.contracts?.tools).toEqual([
      "wecom_doc",
      "wecom_calendar",
      "wecom_mcp",
    ]);
  });

  it("records only successful visible WeCom message deliveries", () => {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const api = {
      runtime: {},
      registerChannel: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn((name: string, handler: (event: any, ctx: any) => void) => {
        handlers.set(name, handler);
      }),
    } as unknown as OpenClawPluginApi;
    plugin.register(api);
    const onMessageSent = handlers.get("message_sent");
    const sessionKey = "agent:ops:wecom:default:dm:alice";

    onMessageSent?.({ success: true, messageId: "visible-1" }, { channelId: "wecom", sessionKey });
    const sequence = getWecomOutboundDeliverySequence(sessionKey);
    expect(sequence).toBeGreaterThan(0);
    onMessageSent?.({ success: false, messageId: "failed" }, { channelId: "wecom", sessionKey });
    onMessageSent?.({ success: true, messageId: "suppressed-1" }, { channelId: "wecom", sessionKey });
    onMessageSent?.({ success: true, messageId: "other" }, { channelId: "slack", sessionKey });
    expect(getWecomOutboundDeliverySequence(sessionKey)).toBe(sequence);
  });
});
