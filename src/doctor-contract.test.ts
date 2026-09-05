import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";

describe("WeCom config doctor", () => {
  it("migrates the previous multi-account Bot and Agent shape", () => {
    const cfg = {
      channels: {
        wecom: {
          defaultAccount: "default",
          accounts: {
            default: {
              bot: {
                primaryTransport: "ws",
                ws: { botId: "legacy-bot", secret: "legacy-secret" },
                dm: { policy: "open", allowFrom: ["*"] },
              },
              agent: {
                corpId: "ww-corp",
                agentSecret: "legacy-agent-secret",
                agentId: 1001,
                token: "callback-token",
                encodingAESKey: "callback-aes",
                dm: { policy: "allowlist", allowFrom: ["alice"] },
              },
            },
          },
        },
      },
    } as never;

    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.channels?.wecom).toEqual({
      defaultAccount: "default",
      accounts: {
        default: {
          connectionMode: "websocket",
          botId: "legacy-bot",
          secret: "legacy-secret",
          dmPolicy: "open",
          allowFrom: ["*"],
          agent: {
            corpId: "ww-corp",
            corpSecret: "legacy-agent-secret",
            agentId: 1001,
            token: "callback-token",
            encodingAESKey: "callback-aes",
            dmPolicy: "allowlist",
            allowFrom: ["alice"],
          },
        },
      },
    });
    expect(result.changes).toHaveLength(2);
  });

  it("keeps canonical values when both canonical and legacy fields exist", () => {
    const cfg = {
      channels: {
        wecom: {
          botId: "canonical-bot",
          secret: "canonical-secret",
          bot: { ws: { botId: "legacy-bot", secret: "legacy-secret" } },
        },
      },
    } as never;

    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.channels?.wecom).toEqual({
      botId: "canonical-bot",
      secret: "canonical-secret",
    });
  });

  it("is idempotent", () => {
    const cfg = {
      channels: {
        wecom: {
          accounts: {
            default: { bot: { primaryTransport: "webhook", token: "token" } },
          },
        },
      },
    } as never;

    const first = normalizeCompatibilityConfig({ cfg });
    expect(normalizeCompatibilityConfig({ cfg: first.config })).toEqual({
      config: first.config,
      changes: [],
    });
  });
});

describe("WeCom config doctor: 2.7.x fork keys", () => {
  it("migrates what has a 3.x equivalent and removes what has none", () => {
    const cfg = {
      channels: {
        wecom: {
          botId: "bot",
          secret: "secret",
          mediaMaxMb: 50,
          streaming: { preview: true },
          mediaDownloadTimeoutMs: 30000,
          media: { tempDir: "/tmp/m", localRoots: ["/srv/share"], downloadTimeoutMs: 60000 },
          network: { egressProxyUrl: "http://127.0.0.1:3128", mediaDownloadTimeoutMs: 60000 },
          routing: { failClosedOnDefaultRoute: true },
          mediaLocalRoots: ["/data/reports"],
          accounts: {
            sales: { botId: "sales-bot", secret: "sales-secret", mediaMaxMb: 20 },
          },
        },
      },
    } as never;

    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.channels?.wecom).toEqual({
      botId: "bot",
      secret: "secret",
      media: { tempDir: "/tmp/m", maxBytes: 50 * 1024 * 1024 },
      network: { egressProxyUrl: "http://127.0.0.1:3128" },
      mediaLocalRoots: ["/data/reports", "/srv/share"],
      accounts: {
        sales: { botId: "sales-bot", secret: "sales-secret", media: { maxBytes: 20 * 1024 * 1024 } },
      },
    });
    expect(result.changes.join("\n")).toContain("streaming");
    expect(result.changes.join("\n")).toContain("routing");
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("keeps an explicit media.maxBytes over the legacy mediaMaxMb", () => {
    const result = normalizeCompatibilityConfig({
      cfg: { channels: { wecom: { mediaMaxMb: 50, media: { maxBytes: 1024 } } } } as never,
    });
    expect(result.config.channels?.wecom).toEqual({ media: { maxBytes: 1024 } });
  });
});
