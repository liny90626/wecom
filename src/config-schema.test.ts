import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wecomChannelConfigSchema, wecomChannelJsonSchema } from "./config-schema.js";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";

/** A channels.wecom section as a 2.7.x fork install actually carries it. */
const forkEraChannel = {
  enabled: true,
  defaultAccount: "default",
  mediaMaxMb: 50,
  streaming: { preview: true },
  media: { tempDir: "/tmp/openclaw-wecom-media", localRoots: ["/srv/company-share"] },
  network: { egressProxyUrl: "http://127.0.0.1:3128", mediaDownloadTimeoutMs: 60000 },
  routing: { failClosedOnDefaultRoute: true },
  accounts: {
    default: {
      enabled: true,
      name: "销售支持",
      mediaMaxMb: 20,
      bot: {
        primaryTransport: "ws",
        streamPlaceholderContent: "正在思考…",
        dm: { policy: "open", allowFrom: ["*"] },
        ws: { botId: "legacy-bot", secret: "legacy-secret" },
      },
      agent: {
        corpId: "ww-corp",
        agentSecret: "legacy-agent-secret",
        agentId: 1000001,
        token: "callback-token",
        encodingAESKey: "callback-aes",
        dm: { policy: "open", allowFrom: [] },
      },
    },
  },
};

describe("WeCom channel config schema", () => {
  it("accepts canonical multi-account Bot config", () => {
    const result = wecomChannelConfigSchema.runtime?.safeParse({
      defaultAccount: "support",
      groupPolicy: "allowlist",
      accounts: {
        sales: {
          connectionMode: "websocket",
          botId: "sales-bot",
          secret: "sales-secret",
        },
        support: {
          connectionMode: "webhook",
          token: "support-token",
          encodingAESKey: "support-aes",
        },
      },
    });

    expect(result?.success).toBe(true);
  });

  it("does not refuse to start on keys the 2.7.x fork accepted", () => {
    // The field report: a flat 2.7.x config with two leftover keys made the CLI exit with
    // `must not have additional properties: "mediaMaxMb", "streaming"`.
    expect(
      wecomChannelConfigSchema.runtime?.safeParse({
        botId: "bot",
        secret: "secret",
        mediaMaxMb: 50,
        streaming: { preview: true },
      }).success,
    ).toBe(true);
    expect(wecomChannelConfigSchema.runtime?.safeParse(forkEraChannel).success).toBe(true);
  });

  it("still rejects wrong types on the keys it reads", () => {
    expect(wecomChannelConfigSchema.runtime?.safeParse({ botId: 123 }).success).toBe(false);
    expect(
      wecomChannelConfigSchema.runtime?.safeParse({ accounts: { a: { dmPolicy: "everyone" } } }).success,
    ).toBe(false);
  });

  it("validates the doctor-migrated shape of a fork-era config", () => {
    const migrated = normalizeCompatibilityConfig({
      cfg: { channels: { wecom: forkEraChannel } } as never,
    });
    expect(
      wecomChannelConfigSchema.runtime?.safeParse(migrated.config.channels?.wecom).success,
    ).toBe(true);
  });

  it("ships the same schema in openclaw.plugin.json for the cold path", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { channelConfigs: { wecom: { schema: unknown } } };
    // Regenerate with: npm run build && node --input-type=module -e "..." (see SESSION_HANDOFF §7)
    expect(manifest.channelConfigs.wecom.schema).toEqual(wecomChannelJsonSchema);
  });
});
