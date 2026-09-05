/** wecom-cli tool and process policy constants. */
export const CLI_TOOL_NAME = "wecom-cli";
export const CLI_LOG = "[wecom-cli:tool]";

/** Maximum time for one business command. */
export const CLI_TIMEOUT_MS = 45_000;
/** Maximum time for the non-interactive auth bootstrap. */
export const CLI_AUTH_TIMEOUT_MS = 30_000;
/** A fallback command has a separate, shorter budget. */
export const CLI_FALLBACK_TIMEOUT_MS = 15_000;
export const CLI_KILL_GRACE_MS = 3_000;
export const CLI_KILL_FORCE_WAIT_MS = 3_000;
export const CLI_MAX_OUTPUT_BYTES = 64 * 1024;
export const CLI_RESIGN_COOLDOWN_MS = 5 * 60 * 1000;

export const CLI_FORBIDDEN_SUBCOMMANDS = new Set(["init"]);
export const CLI_FORBIDDEN_AUTH_ACTIONS = new Set([
  "init",
  "login",
  "logout",
  "bind",
  "unbind",
]);
export const CLI_SUBCOMMAND_RE = /^[a-z][a-z0-9_-]*$/;

/** Checked only outside quotes; spawning always uses shell:false. */
export const CLI_SHELL_METACHARS = /[;|&`<>\n\r]/;

export const CLI_ENV_PASSTHROUGH = [
  "WECOM_CLI_BASE_URL",
  "WECOM_CLI_AUTH_ENDPOINT",
  "WECOM_CLI_ADDITIONAL_HEADERS",
] as const;

export function filterCliEnv(value: Record<string, unknown>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const key of CLI_ENV_PASSTHROUGH) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim()) filtered[key] = entry.trim();
  }
  return filtered;
}

export const CLI_ERR = {
  AUTH_REQUIRED: 893999,
  TOKEN_EXPIRED: 853004,
  TOKEN_INVALID: 853005,
  BAD_CREDENTIAL: 853000,
  RATE_LIMITED: 45009,
} as const;

export const CLI_RESIGN_CODES = new Set<number>([
  CLI_ERR.AUTH_REQUIRED,
  CLI_ERR.TOKEN_EXPIRED,
  CLI_ERR.TOKEN_INVALID,
  CLI_ERR.BAD_CREDENTIAL,
]);
