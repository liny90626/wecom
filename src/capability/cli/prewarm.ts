import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { listWecomAccountIds, resolveWecomAccount } from "../../config/accounts.js";
import { resolveWecomCliConfig } from "../../config/cli.js";
import { ensureSynced, type CliEnvOverrides } from "./credentials.js";
import { locateCliBinary } from "./locate.js";

type PrewarmLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * Warm each configured Bot WS credential directory once at gateway startup.
 * Failures are reported and left for the tool to surface on demand; a broken
 * CLI must not take down the already mature MCP/Bot runtime.
 */
export async function prewarmWecomCliCredentials(
  cfg: OpenClawConfig,
  logger: PrewarmLogger = {},
): Promise<void> {
  for (const accountId of listWecomAccountIds(cfg)) {
    const account = resolveWecomAccount({ cfg, accountId });
    const botId = account.bot?.ws?.botId?.trim() || account.bot?.botId?.trim() || "";
    const secret = account.bot?.ws?.secret?.trim() || account.bot?.secret?.trim() || "";
    if (!account.enabled || !botId || !secret) continue;

    const cliConfig = resolveWecomCliConfig(cfg, accountId);
    const env: CliEnvOverrides = {};
    for (const key of [
      "WECOM_CLI_BASE_URL",
      "WECOM_CLI_AUTH_ENDPOINT",
      "WECOM_CLI_ADDITIONAL_HEADERS",
    ] as const) {
      const value = cliConfig.env?.[key];
      if (typeof value === "string" && value.trim()) env[key] = value.trim();
    }

    try {
      const located = locateCliBinary(cliConfig.binPath);
      if (!located.ok) {
        logger.warn?.(
          `[wecom-cli] 账号 ${accountId} 未找到可执行文件，跳过启动预热；请检查插件依赖或 channels.wecom.cli.binPath。`,
        );
        continue;
      }
      await ensureSynced({
        binPath: located.binPath,
        botId,
        secret,
        env,
      });
      logger.info?.(`[wecom-cli] 账号 ${accountId} 凭据预热完成`);
    } catch (error) {
      logger.warn?.(
        `[wecom-cli] 账号 ${accountId} 凭据预热失败（不影响现有渠道）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
