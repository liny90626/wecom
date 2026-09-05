/**
 * **动态 Agent 路由模块**
 *
 * 为每个用户/群组自动生成独立的 Agent ID，实现会话隔离。
 * 参考: openclaw-plugin-wecom/dynamic-agent.js
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export interface DynamicAgentConfig {
    enabled: boolean;
    dmCreateAgent: boolean;
    groupEnabled: boolean;
    adminUsers: string[];
}

/**
 * **getDynamicAgentConfig (读取动态 Agent 配置)**
 *
 * 从全局配置中读取动态 Agent 配置，提供默认值。
 */
export function getDynamicAgentConfig(config: OpenClawConfig): DynamicAgentConfig {
    const dynamicAgents = (config as { channels?: { wecom?: { dynamicAgents?: Partial<DynamicAgentConfig> } } })?.channels?.wecom?.dynamicAgents;
    return {
        enabled: dynamicAgents?.enabled ?? false,
        dmCreateAgent: dynamicAgents?.dmCreateAgent ?? true,
        groupEnabled: dynamicAgents?.groupEnabled ?? true,
        adminUsers: dynamicAgents?.adminUsers ?? [],
    };
}

function sanitizeDynamicIdPart(value: string): string {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_");
}

/**
 * **generateAgentId (生成动态 Agent ID)**
 *
 * 根据账号 + 聊天类型 + 对端 ID 生成确定性的 Agent ID，避免多账号串会话。
 * 格式: wecom-{accountId}-{type}-{sanitizedPeerId}
 */
export function generateAgentId(chatType: "dm" | "group", peerId: string, accountId?: string): string {
    const sanitizedPeer = sanitizeDynamicIdPart(peerId) || "unknown";
    const sanitizedAccountId = sanitizeDynamicIdPart(accountId ?? "default") || "default";
    return `wecom-${sanitizedAccountId}-${chatType}-${sanitizedPeer}`;
}

export function buildAgentSessionTarget(userId: string, accountId?: string): string {
    const normalizedUserId = String(userId).trim();
    const sanitizedAccountId = sanitizeDynamicIdPart(accountId ?? "default") || "default";
    // Always use explicit user: prefix to avoid ambiguity with numeric party IDs
    return `wecom-agent:${sanitizedAccountId}:user:${normalizedUserId}`;
}

/**
 * **shouldUseDynamicAgent (检查是否使用动态 Agent)**
 *
 * 根据配置和发送者信息判断是否应使用动态 Agent。
 * 管理员（adminUsers）始终绕过动态路由，使用主 Agent。
 */
export function shouldUseDynamicAgent(params: {
    chatType: "dm" | "group";
    senderId: string;
    config: OpenClawConfig;
}): boolean {
    const { chatType, senderId, config } = params;
    const dynamicConfig = getDynamicAgentConfig(config);

    if (!dynamicConfig.enabled) {
        return false;
    }

    // 管理员绕过动态路由
    const sender = String(senderId).trim().toLowerCase();
    const isAdmin = dynamicConfig.adminUsers.some(
        (admin) => admin.trim().toLowerCase() === sender
    );
    if (isAdmin) {
        return false;
    }

    if (chatType === "group") {
        return dynamicConfig.groupEnabled;
    }
    return dynamicConfig.dmCreateAgent;
}

/**
 * 内存中已确保的 Agent ID（避免重复写入）
 */
const ensuredDynamicAgentIds = new Set<string>();

/**
 * 写入队列（避免并发冲突）
 */
let ensureDynamicAgentWriteQueue: Promise<void> = Promise.resolve();

/** Normalized agent ids on the roster, whichever shape the config uses. */
function listRosterAgentIds(cfg: unknown): Set<string> {
    const agents = (cfg as { agents?: Record<string, unknown> } | undefined)?.agents;
    const entries = agents?.entries;
    const ids =
        entries && typeof entries === "object" && !Array.isArray(entries)
            ? Object.keys(entries)
            : Array.isArray(agents?.list)
              ? (agents.list as Array<{ id?: unknown }>).map((entry) => String(entry?.id ?? ""))
              : [];
    return new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean));
}

/**
 * 将 Agent ID 插入 agents.entries / agents.list（如果不存在）
 */
function upsertAgentIdOnlyEntry(cfg: Record<string, unknown>, agentId: string): boolean {
    if (!cfg.agents || typeof cfg.agents !== "object") {
        cfg.agents = {};
    }

    const agentsObj = cfg.agents as Record<string, unknown>;
    // OpenClaw 2026.8.x keeps the roster in `agents.entries` (keyed by id) and
    // only projects `agents.list` from it at runtime; a config authored that
    // way must be extended in `entries`, or the write drops the roster. Same
    // precedence as the core's own reader: `entries` wins whenever present.
    if (agentsObj.entries && typeof agentsObj.entries === "object" && !Array.isArray(agentsObj.entries)) {
        const entries = agentsObj.entries as Record<string, unknown>;
        const existingIds = new Set(Object.keys(entries).map((id) => id.trim().toLowerCase()));
        let changed = false;
        if (existingIds.size === 0) {
            entries.main = {};
            existingIds.add("main");
            changed = true;
        }
        if (!existingIds.has(agentId.toLowerCase())) {
            entries[agentId] = {};
            changed = true;
        }
        return changed;
    }

    const currentList: Array<{ id: string }> = Array.isArray(agentsObj.list) ? agentsObj.list as Array<{ id: string }> : [];
    const existingIds = new Set(
        currentList
            .map((entry) => entry?.id?.trim().toLowerCase())
            .filter((id): id is string => Boolean(id))
    );

    let changed = false;
    const nextList = [...currentList];

    // 首次创建时保留 main 作为默认
    if (nextList.length === 0) {
        nextList.push({ id: "main" });
        existingIds.add("main");
        changed = true;
    }

    if (!existingIds.has(agentId.toLowerCase())) {
        nextList.push({ id: agentId });
        changed = true;
    }

    if (changed) {
        agentsObj.list = nextList;
    }

    return changed;
}

/**
 * **ensureDynamicAgentListed (确保动态 Agent 已添加到 agents.list)**
 *
 * 将动态生成的 Agent ID 添加到 OpenClaw 配置中的 agents.list。
 * 特性：
 * - 幂等：使用内存 Set 避免重复写入
 * - 串行：使用 Promise 队列避免并发冲突
 * - 异步：不阻塞消息处理流程
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureDynamicAgentListed(agentId: string, runtime: any): Promise<void> {
    const normalizedId = String(agentId).trim().toLowerCase();
    if (!normalizedId) return;
    if (ensuredDynamicAgentIds.has(normalizedId)) return;

    // `loadConfig` / `writeConfigFile` left the plugin runtime in 2026.8.x;
    // `current()` + `mutateConfigFile()` are on 2026.7.1-2 as well. The old
    // guard silently skipped the roster write on 8.x, and 8.x refuses to run an
    // agent that is not on the roster ("run workspace resolution requires an
    // explicit roster"), so this write is what keeps dynamic agents usable.
    const configRuntime = runtime?.config;
    if (typeof configRuntime?.mutateConfigFile !== "function") return;

    ensureDynamicAgentWriteQueue = ensureDynamicAgentWriteQueue
        .then(async () => {
            if (ensuredDynamicAgentIds.has(normalizedId)) return;

            // Probe the live snapshot first: an agent that is already listed
            // must not cost a config write and the reload that follows it. Read
            // through property access, not a clone — on 2026.8.x `agents.list`
            // is a non-enumerable runtime projection that a clone would drop.
            if (!listRosterAgentIds(configRuntime.current()).has(normalizedId)) {
                await configRuntime.mutateConfigFile({
                    afterWrite: { mode: "auto" },
                    mutate(draft: Record<string, unknown>) {
                        upsertAgentIdOnlyEntry(draft, normalizedId);
                    },
                });
            }

            ensuredDynamicAgentIds.add(normalizedId);
        })
        .catch((err) => {
            console.warn(`[wecom] 动态 Agent 添加失败: ${normalizedId}`, err);
        });

    await ensureDynamicAgentWriteQueue;
}

/**
 * **resetEnsuredCache (重置已确保缓存)**
 *
 * 主要用于测试场景，重置内存中的缓存状态。
 */
export function resetEnsuredCache(): void {
    ensuredDynamicAgentIds.clear();
}
