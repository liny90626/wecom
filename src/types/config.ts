export type WecomDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
export type WecomBotPrimaryTransport = "ws" | "webhook";

export type WecomDmConfig = {
  policy?: WecomDmPolicy;
  allowFrom?: Array<string | number>;
};

export type WecomMediaConfig = {
  tempDir?: string;
  retentionHours?: number;
  cleanupOnStart?: boolean;
  maxBytes?: number;
  downloadTimeoutMs?: number;
  localRoots?: string[];
};

export type WecomNetworkConfig = {
  egressProxyUrl?: string;
  timeoutMs?: number;
  mediaDownloadTimeoutMs?: number;
};

export type WecomRoutingConfig = {
  failClosedOnDefaultRoute?: boolean;
};

export type WecomBotWsConfig = {
  botId: string;
  secret: string;
};

export type WecomBotWebhookConfig = {
  token: string;
  encodingAESKey: string;
  receiveId?: string;
};

export type WecomBotConfig = {
  primaryTransport?: WecomBotPrimaryTransport;
  streamPlaceholderContent?: string;
  welcomeText?: string;
  dm?: WecomDmConfig;
  /**
   * Deprecated compatibility fields kept only while old webhook helpers are
   * being extracted into transport adapters.
   */
  aibotid?: string;
  botIds?: string[];
  token?: string;
  encodingAESKey?: string;
  receiveId?: string;
  ws?: WecomBotWsConfig;
  webhook?: WecomBotWebhookConfig;
  /**
   * 按 `biz_type` 直接指定 MCP Server 的 streamableHTTP URL。
   *
   * 取值来自机器人管理后台「可使用权限 → 查看使用方式」里复制的地址，形如
   * `https://qyapi.weixin.qq.com/mcp/v2/bot/doc?apikey=…`。**这个 `apikey` 是成员
   * 完成授权之后才签发的**，成员对文档的权限随它一起共享给 MCP 使用者；而
   * `aibot_get_mcp_config` 走的是机器人长连接、另行签发，两者不必然等价。
   *
   * 配置了就直接用它，不再调 `aibot_get_mcp_config`；没配置则行为不变。
   *
   * **这是推荐配置，不是临时兜底。** 现网实测（2026-08-26）证明两条签发路径
   * 指向的是**两台不同的 MCP Server**：
   *   - 后台地址 `/mcp/v2/bot/<biz_type>?apikey=…` → 「动态* MCP」v1.0.5，
   *     `doc` 有 62 个新一代工具（`doc_create` / `sheet_get` / `smartsheet_records_*`），
   *     且服务端返回里自报「授权真人用户身份」——**授权是内嵌在 apikey 里的**；
   *   - `aibot_get_mcp_config` 签发的地址 → 旧一代、19 个工具、**没有绑定真人
   *     用户**，因此对成员拥有的文档一律 `851003 no authority`。
   *
   * 使用者已验证：取消授权再重新授权，apikey **不变**，可安全写入配置。
   */
  mcpServers?: Record<string, string>;
};

/**
 * 上下游企业配置
 * 根据企业微信文档，只需要配置下游企业的 CorpID 和 AgentID
 * 不需要下游企业的 agentSecret，使用主企业的 corpSecret 获取下游企业的 access_token
 */
export type WecomUpstreamCorpConfig = {
  corpId: string;
  agentId: number;
};

export type WecomAgentConfig = {
  corpId: string;
  agentSecret?: string;
  /**
   * Deprecated compatibility alias for old configs.
   * New configs should use `agentSecret`.
   */
  corpSecret?: string;
  agentId?: number | string;
  token: string;
  encodingAESKey: string;
  welcomeText?: string;
  dm?: WecomDmConfig;
  /**
   * 上下游企业配置映射
   * key: 配置名称（可自定义）
   * value: 下游企业的 CorpID 和 AgentID
   * 
   * 注意：不需要配置 agentSecret，使用主企业的 corpSecret 获取下游企业的 access_token
   */
  upstreamCorps?: Record<string, WecomUpstreamCorpConfig>;
};

export type WecomDynamicAgentsConfig = {
  enabled?: boolean;
  dmCreateAgent?: boolean;
  groupEnabled?: boolean;
  adminUsers?: string[];
};

export type WecomAccountConfig = {
  enabled?: boolean;
  name?: string;
  mediaMaxMb?: number;
  bot?: WecomBotConfig;
  agent?: WecomAgentConfig;
};

export type WecomConfig = {
  enabled?: boolean;
  mediaMaxMb?: number;
  mediaDownloadTimeoutMs?: number;
  bot?: WecomBotConfig;
  agent?: WecomAgentConfig;
  accounts?: Record<string, WecomAccountConfig>;
  defaultAccount?: string;
  media?: WecomMediaConfig;
  network?: WecomNetworkConfig;
  routing?: WecomRoutingConfig;
  dynamicAgents?: WecomDynamicAgentsConfig;
};
