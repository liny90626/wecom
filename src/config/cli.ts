import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

import { resolveWecomAccount } from "./accounts.js";
import type { WecomCliConfig, WecomConfig } from "../types/index.js";

/**
 * Resolve the CLI escape hatch without changing the existing account resolver.
 * Account-level values win; the top-level value remains the legacy/single-account
 * default. Environment values are merged field-by-field so one account can
 * override a single endpoint without losing the other configured values.
 */
export function resolveWecomCliConfig(
  cfg: OpenClawConfig,
  accountId?: string | null,
): WecomCliConfig {
  const wecom = (cfg.channels?.wecom as WecomConfig | undefined) ?? {};
  const account = resolveWecomAccount({ cfg, accountId });
  const accountConfig = account.config;
  const top = wecom.cli;
  const scoped = accountConfig.cli;
  const env = {
    ...(top?.env ?? {}),
    ...(scoped?.env ?? {}),
  };
  return {
    ...(top?.binPath || scoped?.binPath
      ? { binPath: scoped?.binPath ?? top?.binPath }
      : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
