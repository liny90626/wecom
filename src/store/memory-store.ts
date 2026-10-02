import type { RuntimeStore } from "./interfaces.js";
import type { TransportSessionSnapshot, UnifiedInboundEvent } from "../types/index.js";
import { buildDedupKey } from "../domain/policies.js";

/**
 * How long an inbound message id stays deduplicated. WeCom redelivers within
 * minutes; past this window a key is dropped so a gateway that runs for weeks
 * does not keep one entry per message it ever received.
 */
const INBOUND_SEEN_TTL_MS = 30 * 60_000;

export class InMemoryRuntimeStore implements RuntimeStore {
  // Insertion order is arrival order (keys are never re-set), so expired keys
  // are always at the front and pruning stops at the first live one.
  private readonly seen = new Map<string, number>();
  private readonly transportSessions = new Map<string, TransportSessionSnapshot>();

  private pruneSeen(now: number): void {
    for (const [key, seenAt] of this.seen) {
      if (now - seenAt < INBOUND_SEEN_TTL_MS) {
        return;
      }
      this.seen.delete(key);
    }
  }

  hasSeenInbound(event: UnifiedInboundEvent): boolean {
    this.pruneSeen(Date.now());
    return this.seen.has(buildDedupKey(event));
  }

  markInboundSeen(event: UnifiedInboundEvent): boolean {
    const now = Date.now();
    this.pruneSeen(now);
    const key = buildDedupKey(event);
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, now);
    return true;
  }

  readTransportSession(accountId: string, transport: TransportSessionSnapshot["transport"]): TransportSessionSnapshot | undefined {
    return this.transportSessions.get(`${accountId}:${transport}`);
  }

  writeTransportSession(snapshot: TransportSessionSnapshot): void {
    this.transportSessions.set(`${snapshot.accountId}:${snapshot.transport}`, snapshot);
  }
}
