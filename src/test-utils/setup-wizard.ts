import type { ChannelPlugin, OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";

type SetupWizard = NonNullable<ChannelPlugin["setupWizard"]>;

export function buildChannelSetupWizardAdapterFromSetupWizard(params: {
  plugin: ChannelPlugin;
  wizard: SetupWizard;
}) {
  return {
    dmPolicy: undefined,
    configure: async (ctx: {
      cfg: OpenClawConfig;
      runtime: unknown;
      prompter: WizardPrompter;
      options: Record<string, unknown>;
      accountOverrides: Record<string, unknown>;
      shouldPromptAccountIds: boolean;
      forceAllowFrom: boolean;
    }) => {
      const wizard = params.wizard as unknown as {
        resolveAccountIdForConfigure?: (params: {
          cfg: OpenClawConfig;
          prompter: WizardPrompter;
          accountOverride?: string;
          shouldPromptAccountIds: boolean;
        }) => Promise<string>;
        finalize?: (params: {
          cfg: OpenClawConfig;
          accountId: string;
          prompter: WizardPrompter;
        }) => Promise<{ cfg: OpenClawConfig }>;
      };
      const override =
        typeof ctx.accountOverrides?.accountId === "string"
          ? ctx.accountOverrides.accountId
          : undefined;
      const accountId =
        (await wizard.resolveAccountIdForConfigure?.({
          cfg: ctx.cfg,
          prompter: ctx.prompter,
          accountOverride: override,
          shouldPromptAccountIds: ctx.shouldPromptAccountIds,
        })) ?? "default";
      const finalized = await wizard.finalize?.({
        cfg: ctx.cfg,
        accountId,
        prompter: ctx.prompter,
      });
      return {
        accountId,
        cfg: finalized?.cfg ?? ctx.cfg,
      };
    },
    getStatus: async (ctx: {
      cfg: OpenClawConfig;
      options: Record<string, unknown>;
      accountOverrides: Record<string, unknown>;
    }) => {
      const configured = params.plugin.config.listAccountIds(ctx.cfg).some((accountId) => {
        const account = params.plugin.config.resolveAccount(ctx.cfg, accountId);
        return account.enabled !== false && account.configured;
      });
      return {
        statusLines: [`WeCom (企业微信): ${configured ? "已配置" : "需要配置"}`],
        selectionHint: "官方推荐 · 功能强大 · 上手简单",
      };
    },
  };
}
