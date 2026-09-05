import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import * as channelSetupSdk from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/setup";
import { patchScopedAccountConfig } from "openclaw/plugin-sdk/setup";
import { hasMultiAccounts, resolveWeComAccountMulti } from "./accounts.js";
import { CHANNEL_ID } from "./const.js";

type WeComSetupInput = {
  name?: string;
  connectionMode?: "websocket" | "webhook";
  botId?: string;
  secret?: string;
  token?: string;
  encodingAesKey?: string;
  receiveId?: string;
};

type WecomSetupAdapter = {
  configPromotion?: "preserve-root";
  resolveAccountId?: (params: { accountId?: string }) => string;
  applyAccountName?: (params: { cfg: OpenClawConfig; accountId: string; name?: string }) => OpenClawConfig;
  validateInput?: (params: { cfg: OpenClawConfig; accountId: string; input: WeComSetupInput }) => string | null;
  applyAccountConfig: (params: { cfg: OpenClawConfig; accountId: string; input: WeComSetupInput }) => OpenClawConfig;
  singleAccountKeysToMove?: readonly string[];
};

export function patchWeComAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  return patchScopedAccountConfig({
    cfg: params.cfg,
    channelKey: CHANNEL_ID,
    accountId,
    patch: params.patch,
    accountPatch: { enabled: true, ...params.patch },
    ensureChannelEnabled: true,
    ensureAccountEnabled: true,
    // Preserve the existing multi-account identity instead of creating a second
    // implicit default account at the channel root during setup or rotation.
    scopeDefaultToAccounts: hasMultiAccounts(params.cfg),
  });
}

export const wecomSetupAdapter: WecomSetupAdapter = {
  configPromotion: "preserve-root",
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId ?? "default"),
  applyAccountName: ({ cfg, accountId, name }) =>
    patchWeComAccountConfig({
      cfg,
      accountId,
      patch: name?.trim() ? { name: name.trim() } : {},
    }),
  validateInput: ({ cfg, accountId, input }) => {
    const existing = resolveWeComAccountMulti({ cfg, accountId });
    const mode = input.connectionMode ?? existing.config.connectionMode ?? "websocket";
    if (mode === "websocket") {
      const botId = input.botId?.trim() || existing.botId.trim();
      const secret = input.secret?.trim() || existing.secret.trim();
      return botId && secret ? null : "WeCom WebSocket Bot mode requires --bot-id and --secret.";
    }
    const token = input.token?.trim() || existing.token?.trim();
    const encodingAESKey = input.encodingAesKey?.trim() || existing.encodingAESKey?.trim();
    return token && encodingAESKey
      ? null
      : "WeCom Webhook Bot mode requires --token and --encoding-aes-key.";
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const patch: Record<string, unknown> = {};
    for (const key of [
      "connectionMode",
      "botId",
      "secret",
      "token",
      "receiveId",
    ] as const) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) {
        patch[key] = value.trim();
      }
    }
    if (typeof input.encodingAesKey === "string" && input.encodingAesKey.trim()) {
      patch.encodingAESKey = input.encodingAesKey.trim();
    }
    return patchWeComAccountConfig({ cfg, accountId, patch });
  },
  singleAccountKeysToMove: [
    "name",
    "connectionMode",
    "websocketUrl",
    "botId",
    "secret",
    "token",
    "encodingAESKey",
    "receiveId",
    "dmPolicy",
    "allowFrom",
    "groupPolicy",
    "groupAllowFrom",
    "groups",
    "agent",
    "network",
    "media",
    "dynamicAgents",
    "cli",
    "sendThinkingMessage",
    "mediaLocalRoots",
    "welcomeText",
    "streamPlaceholderContent",
  ],
};

const setupContractInput = {
    fields: {
      connectionMode: {
        kind: "choice",
        choices: ["websocket", "webhook"],
        cli: {
          flags: "--connection-mode <mode>",
          description: "WeCom Bot connection mode (websocket or webhook)",
        },
      },
      botId: {
        kind: "string",
        sensitive: true,
        cli: { flags: "--bot-id <id>", description: "WeCom Bot ID" },
      },
      secret: {
        kind: "string",
        sensitive: true,
        cli: { flags: "--secret <secret>", description: "WeCom Bot secret" },
      },
      token: {
        kind: "string",
        sensitive: true,
        cli: { flags: "--token <token>", description: "WeCom webhook token" },
      },
      encodingAesKey: {
        kind: "string",
        sensitive: true,
        cli: {
          flags: "--encoding-aes-key <key>",
          description: "WeCom webhook EncodingAESKey",
        },
      },
      receiveId: {
        kind: "string",
        cli: { flags: "--receive-id <id>", description: "WeCom webhook receiver ID" },
      },
    },
  adapter: wecomSetupAdapter,
};

type SetupContractFactory = (input: typeof setupContractInput) => unknown;
const setupContractFactory = (channelSetupSdk as unknown as {
  defineChannelSetupContract?: SetupContractFactory;
}).defineChannelSetupContract;

/** OpenClaw 7.1 has no setup-contract factory; its setup adapter remains supported. */
export const wecomSetupContract: unknown = typeof setupContractFactory === "function"
  ? setupContractFactory(setupContractInput)
  : undefined;
