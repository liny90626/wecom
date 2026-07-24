export type WecomSourcePlane = "bot-ws" | "agent-callback";

export type WecomSourceSnapshot = {
  accountId: string;
  source: WecomSourcePlane;
  recordedAt: number;
  messageId?: string;
  sessionKey?: string;
  sessionId?: string;
  peerKind?: "direct" | "group";
  peerId?: string;
  upstreamCorpId?: string;
};

const MAX_MESSAGE_FACTS = 2048;
const MAX_SESSION_SNAPSHOTS = 1024;
const MAX_CONVERSATION_SNAPSHOTS = 1024;

const messageFacts = new Map<string, WecomSourceSnapshot>();
const sessionSnapshotsByAccountKey = new Map<string, WecomSourceSnapshot>();
const sessionSnapshotsByLooseKey = new Map<string, WecomSourceSnapshot>();
const conversationSnapshotsByAccountKey = new Map<string, WecomSourceSnapshot>();
const conversationSnapshotsByLooseKey = new Map<string, WecomSourceSnapshot>();

function normalizeOptional(value: string | null | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}

function messageFactKey(accountId: string, messageId: string): string {
  return `${accountId}::${messageId}`;
}

function accountScopedSessionKey(
  accountId: string,
  kind: "sessionKey" | "sessionId",
  value: string,
): string {
  return `${accountId}::${kind}::${value}`;
}

function normalizePeerId(value: string | null | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizePeerKind(value: string | null | undefined): "direct" | "group" | undefined {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return trimmed === "direct" || trimmed === "group" ? trimmed : undefined;
}

function accountScopedConversationKey(
  accountId: string,
  peerKind: "direct" | "group",
  peerId: string,
): string {
  return `${accountId}::peer::${peerKind}::${peerId}`;
}

function pruneOldest<T>(map: Map<string, T>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) return;
    map.delete(oldestKey);
  }
}

function setMostRecent<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
}

function writeSessionSnapshot(snapshot: WecomSourceSnapshot): void {
  const sessionKey = normalizeOptional(snapshot.sessionKey);
  const sessionId = normalizeOptional(snapshot.sessionId);
  if (sessionKey) {
    setMostRecent(
      sessionSnapshotsByAccountKey,
      accountScopedSessionKey(snapshot.accountId, "sessionKey", sessionKey),
      snapshot,
    );
    setMostRecent(sessionSnapshotsByLooseKey, `sessionKey::${sessionKey}`, snapshot);
  }
  if (sessionId) {
    setMostRecent(
      sessionSnapshotsByAccountKey,
      accountScopedSessionKey(snapshot.accountId, "sessionId", sessionId),
      snapshot,
    );
    setMostRecent(sessionSnapshotsByLooseKey, `sessionId::${sessionId}`, snapshot);
  }
  pruneOldest(sessionSnapshotsByAccountKey, MAX_SESSION_SNAPSHOTS * 2);
  pruneOldest(sessionSnapshotsByLooseKey, MAX_SESSION_SNAPSHOTS * 2);
}

function writeConversationSnapshot(snapshot: WecomSourceSnapshot): void {
  const peerKind = normalizePeerKind(snapshot.peerKind);
  const peerId = normalizePeerId(snapshot.peerId);
  if (!peerKind || !peerId) {
    return;
  }
  setMostRecent(
    conversationSnapshotsByAccountKey,
    accountScopedConversationKey(snapshot.accountId, peerKind, peerId),
    {
      ...snapshot,
      peerKind,
      peerId,
    },
  );
  setMostRecent(conversationSnapshotsByLooseKey, `peer::${peerKind}::${peerId}`, {
    ...snapshot,
    peerKind,
    peerId,
  });
  pruneOldest(conversationSnapshotsByAccountKey, MAX_CONVERSATION_SNAPSHOTS);
  pruneOldest(conversationSnapshotsByLooseKey, MAX_CONVERSATION_SNAPSHOTS);
}

export function registerWecomSourceSnapshot(params: {
  accountId: string;
  source: WecomSourcePlane;
  messageId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  peerKind?: "direct" | "group" | null;
  peerId?: string | null;
  upstreamCorpId?: string | null;
}): void {
  const accountId = normalizeOptional(params.accountId);
  if (!accountId) return;

  const snapshot: WecomSourceSnapshot = {
    accountId,
    source: params.source,
    recordedAt: Date.now(),
    ...(normalizeOptional(params.messageId)
      ? { messageId: normalizeOptional(params.messageId) }
      : {}),
    ...(normalizeOptional(params.sessionKey)
      ? { sessionKey: normalizeOptional(params.sessionKey) }
      : {}),
    ...(normalizeOptional(params.sessionId)
      ? { sessionId: normalizeOptional(params.sessionId) }
      : {}),
    ...(normalizePeerKind(params.peerKind) ? { peerKind: normalizePeerKind(params.peerKind) } : {}),
    ...(normalizePeerId(params.peerId) ? { peerId: normalizePeerId(params.peerId) } : {}),
    ...(normalizeOptional(params.upstreamCorpId)
      ? { upstreamCorpId: normalizeOptional(params.upstreamCorpId) }
      : {}),
  };

  if (snapshot.messageId) {
    setMostRecent(messageFacts, messageFactKey(accountId, snapshot.messageId), snapshot);
    pruneOldest(messageFacts, MAX_MESSAGE_FACTS);
  }

  writeSessionSnapshot(snapshot);
  writeConversationSnapshot(snapshot);
}

export function resolveWecomSourceSnapshot(params: {
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  peerKind?: "direct" | "group" | null;
  peerId?: string | null;
}): WecomSourceSnapshot | undefined {
  const accountId = normalizeOptional(params.accountId);
  const sessionKey = normalizeOptional(params.sessionKey);
  const sessionId = normalizeOptional(params.sessionId);
  const peerKind = normalizePeerKind(params.peerKind);
  const peerId = normalizePeerId(params.peerId);

  if (accountId && sessionKey) {
    const scoped = sessionSnapshotsByAccountKey.get(
      accountScopedSessionKey(accountId, "sessionKey", sessionKey),
    );
    if (scoped) return scoped;
  }
  if (accountId && sessionId) {
    const scoped = sessionSnapshotsByAccountKey.get(
      accountScopedSessionKey(accountId, "sessionId", sessionId),
    );
    if (scoped) return scoped;
  }
  if (accountId && peerKind && peerId) {
    const scoped = conversationSnapshotsByAccountKey.get(
      accountScopedConversationKey(accountId, peerKind, peerId),
    );
    if (scoped) return scoped;
  }
  if (accountId) {
    return undefined;
  }
  if (sessionKey) {
    const loose = sessionSnapshotsByLooseKey.get(`sessionKey::${sessionKey}`);
    if (loose) return loose;
  }
  if (sessionId) {
    const loose = sessionSnapshotsByLooseKey.get(`sessionId::${sessionId}`);
    if (loose) return loose;
  }
  if (peerKind && peerId) {
    const loose = conversationSnapshotsByLooseKey.get(`peer::${peerKind}::${peerId}`);
    if (loose) return loose;
  }
  return undefined;
}

export function clearWecomSourceAccount(accountId: string): void {
  const normalized = normalizeOptional(accountId);
  if (!normalized) return;

  for (const [key, value] of messageFacts) {
    if (value.accountId === normalized || key.startsWith(`${normalized}::`)) {
      messageFacts.delete(key);
    }
  }
  for (const [key, value] of sessionSnapshotsByAccountKey) {
    if (value.accountId === normalized || key.startsWith(`${normalized}::`)) {
      sessionSnapshotsByAccountKey.delete(key);
    }
  }
  for (const [key, value] of sessionSnapshotsByLooseKey) {
    if (value.accountId === normalized) {
      sessionSnapshotsByLooseKey.delete(key);
    }
  }
  for (const [key, value] of conversationSnapshotsByAccountKey) {
    if (value.accountId === normalized || key.startsWith(`${normalized}::`)) {
      conversationSnapshotsByAccountKey.delete(key);
    }
  }
  for (const [key, value] of conversationSnapshotsByLooseKey) {
    if (value.accountId === normalized) {
      conversationSnapshotsByLooseKey.delete(key);
    }
  }
}

export function isWecomBotWsSource(params: {
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  peerKind?: "direct" | "group" | null;
  peerId?: string | null;
}): boolean {
  return resolveWecomSourceSnapshot(params)?.source === "bot-ws";
}

export function isWecomAgentSource(params: {
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  peerKind?: "direct" | "group" | null;
  peerId?: string | null;
}): boolean {
  return resolveWecomSourceSnapshot(params)?.source === "agent-callback";
}
