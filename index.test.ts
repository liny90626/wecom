import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("wecom plugin register", () => {
  it("registers both recommended and legacy webhook route prefixes", () => {
    const registerChannel = vi.fn();
    const registerHttpRoute = vi.fn();
    const registerTool = vi.fn();
    const registerService = vi.fn();
    const on = vi.fn();
    const api = {
      runtime: {},
      registerChannel,
      registerHttpRoute,
      registerTool,
      registerService,
      logger: { info: vi.fn(), warn: vi.fn() },
      on,
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    expect(registerChannel).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute).toHaveBeenCalledTimes(2);
    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wecom-cli-credentials" }),
    );
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
      "wecom-cli",
    ]);
    expect(manifest.skills).toEqual(["./skills"]);
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.["@wecom/cli"]).toBe("1.2.0");
  });

});
