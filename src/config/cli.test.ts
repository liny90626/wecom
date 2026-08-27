import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { resolveWecomCliConfig } from "./cli.js";

describe("resolveWecomCliConfig", () => {
  it("uses top-level CLI settings for the legacy account", () => {
    const cfg = {
      channels: {
        wecom: {
          cli: {
            binPath: "/opt/wecom-cli",
            env: { WECOM_CLI_BASE_URL: "https://example.test" },
          },
          bot: { ws: { botId: "bot", secret: "secret" } },
        },
      },
    } as OpenClawConfig;
    expect(resolveWecomCliConfig(cfg)).toEqual({
      binPath: "/opt/wecom-cli",
      env: { WECOM_CLI_BASE_URL: "https://example.test" },
    });
  });

  it("lets an account override one top-level value without dropping the rest", () => {
    const cfg = {
      channels: {
        wecom: {
          cli: {
            binPath: "/opt/default-cli",
            env: {
              WECOM_CLI_BASE_URL: "https://prod.example",
              WECOM_CLI_AUTH_ENDPOINT: "https://auth.example",
            },
          },
          accounts: {
            account_a: {
              cli: { binPath: "/opt/account-cli", env: { WECOM_CLI_BASE_URL: "https://test.example" } },
              bot: { ws: { botId: "bot-a", secret: "secret-a" } },
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveWecomCliConfig(cfg, "account_a")).toEqual({
      binPath: "/opt/account-cli",
      env: {
        WECOM_CLI_BASE_URL: "https://test.example",
        WECOM_CLI_AUTH_ENDPOINT: "https://auth.example",
      },
    });
  });
});
