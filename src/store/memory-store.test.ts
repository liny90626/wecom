import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnifiedInboundEvent } from "../types/index.js";
import { InMemoryRuntimeStore } from "./memory-store.js";

const inbound = (messageId: string): UnifiedInboundEvent =>
  ({ accountId: "acct", transport: "bot-ws", messageId }) as UnifiedInboundEvent;

describe("InMemoryRuntimeStore inbound dedupe", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a redelivery inside the window and reports it as seen", () => {
    const store = new InMemoryRuntimeStore();
    expect(store.hasSeenInbound(inbound("m1"))).toBe(false);
    expect(store.markInboundSeen(inbound("m1"))).toBe(true);
    expect(store.hasSeenInbound(inbound("m1"))).toBe(true);
    expect(store.markInboundSeen(inbound("m1"))).toBe(false);
  });

  it("forgets ids after the window so a long-running gateway does not grow per message", () => {
    vi.useFakeTimers();
    const store = new InMemoryRuntimeStore();
    for (let i = 0; i < 1000; i += 1) {
      store.markInboundSeen(inbound(`old-${i}`));
    }
    vi.advanceTimersByTime(29 * 60_000);
    store.markInboundSeen(inbound("recent"));
    vi.advanceTimersByTime(2 * 60_000);

    expect(store.hasSeenInbound(inbound("old-0"))).toBe(false);
    expect(store.hasSeenInbound(inbound("recent"))).toBe(true);
    expect((store as unknown as { seen: Map<string, number> }).seen.size).toBe(1);
  });
});
