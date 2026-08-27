export interface DmConfig {
  policy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: (string | number)[];
}

export interface MediaConfig {
  tempDir?: string;
  retentionHours?: number;
  cleanupOnStart?: boolean;
  maxBytes?: number;
  downloadTimeoutMs?: number;
  localRoots?: string[];
}

export interface NetworkConfig {
  egressProxyUrl?: string;
  timeoutMs?: number;
  mediaDownloadTimeoutMs?: number;
}

export interface RoutingConfig {
  failClosedOnDefaultRoute?: boolean;
}

export type CliEnv = Partial<
  Record<
    "WECOM_CLI_BASE_URL" | "WECOM_CLI_AUTH_ENDPOINT" | "WECOM_CLI_ADDITIONAL_HEADERS",
    string
  >
>;

export interface CliConfig {
  binPath?: string;
  env?: CliEnv;
}

export interface BotWsConfig {
  botId: string;
  secret: string;
}

export interface BotWebhookConfig {
  token: string;
  encodingAESKey: string;
  receiveId?: string;
}

export interface BotConfig {
  primaryTransport?: "ws" | "webhook";
  streamPlaceholderContent?: string;
  welcomeText?: string;
  dm?: DmConfig;
  aibotid?: string;
  botIds?: string[];
  ws?: BotWsConfig;
  webhook?: BotWebhookConfig;
  /** 按 biz_type 直接指定 MCP Server 的 streamableHTTP URL（后台「查看使用方式」复制）。 */
  mcpServers?: Record<string, string>;
}

export interface AgentConfig {
  corpId: string;
  agentSecret?: string;
  corpSecret?: string;
  agentId?: number | string;
  token: string;
  encodingAESKey: string;
  welcomeText?: string;
  dm?: DmConfig;
}

export interface DynamicAgentsConfig {
  enabled?: boolean;
  dmCreateAgent?: boolean;
  groupEnabled?: boolean;
  adminUsers?: string[];
}

export interface AccountConfig {
  enabled?: boolean;
  name?: string;
  mediaMaxMb?: number;
  cli?: CliConfig;
  bot?: BotConfig;
  agent?: AgentConfig;
}

export interface WecomConfigInput {
  enabled?: boolean;
  mediaMaxMb?: number;
  mediaDownloadTimeoutMs?: number;
  bot?: BotConfig;
  agent?: AgentConfig;
  accounts?: Record<string, AccountConfig>;
  defaultAccount?: string;
  cli?: CliConfig;
  media?: MediaConfig;
  network?: NetworkConfig;
  routing?: RoutingConfig;
  dynamicAgents?: DynamicAgentsConfig;
}

/**
 * @deprecated No longer a Zod schema. Kept as a type-only export for backward compatibility.
 */
export const WecomConfigSchema = undefined;
