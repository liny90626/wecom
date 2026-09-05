import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asNullableRecord as asObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function hasLegacyBotShape(value: unknown): boolean {
  return asObjectRecord(value)?.bot !== undefined;
}

function hasLegacyAgentShape(value: unknown): boolean {
  const agent = asObjectRecord(asObjectRecord(value)?.agent);
  return Boolean(agent && (agent.agentSecret !== undefined || agent.dm !== undefined));
}

const MEBIBYTE = 1024 * 1024;

/**
 * 2.7.x fork 时代的键。新基线不读取它们；schema 对它们宽容（网关照常启动），
 * doctor --fix 把有对应物的迁走、没有的删掉。
 */
const FORK_LEGACY_REMOVALS: ReadonlyArray<readonly [key: string, note: string]> = [
  ["mediaDownloadTimeoutMs", "3.x uses fixed download timeouts (30 s image / 60 s file)"],
  ["routing", "3.x fails closed on unknown accounts by design"],
  ["streaming", "never read by this plugin"],
];

function hasForkLegacyKeys(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) return false;
  if (entry.mediaMaxMb !== undefined) return true;
  if (FORK_LEGACY_REMOVALS.some(([key]) => entry[key] !== undefined)) return true;
  const media = asObjectRecord(entry.media);
  if (media && (media.localRoots !== undefined || media.downloadTimeoutMs !== undefined)) return true;
  return asObjectRecord(entry.network)?.mediaDownloadTimeoutMs !== undefined;
}

function hasLegacyEntryShape(value: unknown): boolean {
  return hasLegacyBotShape(value) || hasLegacyAgentShape(value) || hasForkLegacyKeys(value);
}

function hasLegacyAccountEntry(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) return false;
  if (hasLegacyEntryShape(entry)) return true;
  const accounts = asObjectRecord(entry.accounts);
  return Boolean(accounts && Object.values(accounts).some(hasLegacyEntryShape));
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "wecom"],
    message:
      'channels.wecom contains pre-official Bot/Agent nesting or 2.7.x-only keys (mediaMaxMb, media.localRoots, streaming…). Run "openclaw doctor --fix" to migrate it to the official flat account shape.',
    match: hasLegacyAccountEntry,
  },
];

function copyWhenMissing(
  target: Record<string, unknown>,
  targetKey: string,
  value: unknown,
): void {
  if (target[targetKey] === undefined && value !== undefined) {
    target[targetKey] = value;
  }
}

function normalizeLegacyWecomEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const bot = asObjectRecord(params.entry.bot);
  const rawAgent = asObjectRecord(params.entry.agent);
  if (!bot && !hasLegacyAgentShape(params.entry)) {
    return { entry: params.entry, changed: false };
  }

  const next = { ...params.entry };
  if (bot) {
    const ws = asObjectRecord(bot.ws);
    const webhook = asObjectRecord(bot.webhook);
    copyWhenMissing(
      next,
      "connectionMode",
      bot.primaryTransport === "ws"
        ? "websocket"
        : bot.primaryTransport === "webhook"
          ? "webhook"
          : undefined,
    );
    copyWhenMissing(next, "botId", ws?.botId);
    copyWhenMissing(next, "secret", ws?.secret);
    copyWhenMissing(next, "token", webhook?.token ?? bot.token);
    copyWhenMissing(next, "encodingAESKey", webhook?.encodingAESKey ?? bot.encodingAESKey);
    copyWhenMissing(next, "receiveId", webhook?.receiveId);
    copyWhenMissing(next, "streamPlaceholderContent", bot.streamPlaceholderContent);
    copyWhenMissing(next, "welcomeText", bot.welcomeText);
    const dm = asObjectRecord(bot.dm);
    copyWhenMissing(next, "dmPolicy", dm?.policy);
    copyWhenMissing(next, "allowFrom", dm?.allowFrom);
    delete next.bot;
    params.changes.push(
      `Migrated ${params.pathPrefix}.bot to the official flat WeCom Bot account fields.`,
    );
  }

  if (rawAgent && (rawAgent.agentSecret !== undefined || rawAgent.dm !== undefined)) {
    const agent = { ...rawAgent };
    copyWhenMissing(agent, "corpSecret", agent.agentSecret);
    const dm = asObjectRecord(agent.dm);
    copyWhenMissing(agent, "dmPolicy", dm?.policy);
    copyWhenMissing(agent, "allowFrom", dm?.allowFrom);
    delete agent.agentSecret;
    delete agent.dm;
    next.agent = agent;
    params.changes.push(
      `Migrated ${params.pathPrefix}.agent legacy secret and DM fields.`,
    );
  }

  return { entry: next, changed: true };
}

/** Drops an object key when the object would otherwise be left empty. */
function withoutEmptyObject(target: Record<string, unknown>, key: string): void {
  const value = asObjectRecord(target[key]);
  if (value && Object.keys(value).length === 0) {
    delete target[key];
  }
}

function normalizeForkLegacyEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  if (!hasForkLegacyKeys(params.entry)) {
    return { entry: params.entry, changed: false };
  }
  const { pathPrefix, changes } = params;
  const next = { ...params.entry };

  if (next.mediaMaxMb !== undefined) {
    if (typeof next.mediaMaxMb === "number" && next.mediaMaxMb > 0) {
      const media = { ...(asObjectRecord(next.media) ?? {}) };
      copyWhenMissing(media, "maxBytes", next.mediaMaxMb * MEBIBYTE);
      next.media = media;
      changes.push(`Migrated ${pathPrefix}.mediaMaxMb to ${pathPrefix}.media.maxBytes.`);
    } else {
      changes.push(`Removed ${pathPrefix}.mediaMaxMb: not a positive number.`);
    }
    delete next.mediaMaxMb;
  }

  const media = asObjectRecord(next.media);
  if (media && (media.localRoots !== undefined || media.downloadTimeoutMs !== undefined)) {
    const nextMedia = { ...media };
    if (Array.isArray(nextMedia.localRoots)) {
      const roots = Array.isArray(next.mediaLocalRoots) ? next.mediaLocalRoots : [];
      next.mediaLocalRoots = [...new Set([...roots, ...nextMedia.localRoots])];
      changes.push(`Migrated ${pathPrefix}.media.localRoots to ${pathPrefix}.mediaLocalRoots.`);
    }
    if (nextMedia.downloadTimeoutMs !== undefined) {
      changes.push(`Removed ${pathPrefix}.media.downloadTimeoutMs: 3.x uses fixed download timeouts.`);
    }
    delete nextMedia.localRoots;
    delete nextMedia.downloadTimeoutMs;
    next.media = nextMedia;
    withoutEmptyObject(next, "media");
  }

  const network = asObjectRecord(next.network);
  if (network?.mediaDownloadTimeoutMs !== undefined) {
    const nextNetwork = { ...network };
    delete nextNetwork.mediaDownloadTimeoutMs;
    next.network = nextNetwork;
    withoutEmptyObject(next, "network");
    changes.push(`Removed ${pathPrefix}.network.mediaDownloadTimeoutMs: 3.x uses fixed download timeouts.`);
  }

  for (const [key, note] of FORK_LEGACY_REMOVALS) {
    if (next[key] !== undefined) {
      delete next[key];
      changes.push(`Removed ${pathPrefix}.${key}: ${note}.`);
    }
  }

  return { entry: next, changed: true };
}

/** Official nesting first, then the fork-only keys, on one channel or account entry. */
function normalizeEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const official = normalizeLegacyWecomEntry(params);
  const fork = normalizeForkLegacyEntry({ ...params, entry: official.entry });
  return { entry: fork.entry, changed: official.changed || fork.changed };
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const channels = asObjectRecord(cfg.channels);
  const channel = asObjectRecord(channels?.wecom);
  const changes: string[] = [];
  if (!channel) {
    return { config: cfg, changes };
  }

  const root = normalizeEntry({
    entry: channel,
    pathPrefix: "channels.wecom",
    changes,
  });
  const rawAccounts = asObjectRecord(root.entry.accounts);
  let accountsChanged = false;
  let accounts = rawAccounts;
  if (rawAccounts) {
    accounts = { ...rawAccounts };
    for (const [accountId, value] of Object.entries(rawAccounts)) {
      const account = asObjectRecord(value);
      if (!account) continue;
      const normalized = normalizeEntry({
        entry: account,
        pathPrefix: `channels.wecom.accounts.${accountId}`,
        changes,
      });
      if (normalized.changed) {
        accounts[accountId] = normalized.entry;
        accountsChanged = true;
      }
    }
  }

  if (!root.changed && !accountsChanged) {
    return { config: cfg, changes };
  }
  const nextChannel = accountsChanged ? { ...root.entry, accounts } : root.entry;
  return {
    config: {
      ...cfg,
      channels: { ...channels, wecom: nextChannel },
    } as OpenClawConfig,
    changes,
  };
}
