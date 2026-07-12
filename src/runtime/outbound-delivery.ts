const MAX_TRACKED_SESSIONS = 2_048;

const deliverySequenceBySession = new Map<string, number>();
let nextDeliverySequence = 0;

function normalizeSessionKey(sessionKey: string | null | undefined): string | undefined {
  const normalized = String(sessionKey ?? "").trim();
  return normalized || undefined;
}

export function getWecomOutboundDeliverySequence(
  sessionKey: string | null | undefined,
): number {
  const normalized = normalizeSessionKey(sessionKey);
  return normalized ? (deliverySequenceBySession.get(normalized) ?? 0) : 0;
}

export function recordWecomOutboundDelivery(sessionKey: string | null | undefined): void {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) return;
  nextDeliverySequence += 1;
  deliverySequenceBySession.delete(normalized);
  deliverySequenceBySession.set(normalized, nextDeliverySequence);
  while (deliverySequenceBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = deliverySequenceBySession.keys().next().value;
    if (!oldest) return;
    deliverySequenceBySession.delete(oldest);
  }
}

export function clearWecomOutboundDeliveriesForTest(): void {
  deliverySequenceBySession.clear();
  nextDeliverySequence = 0;
}
