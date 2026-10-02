import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>);

vi.mock("../../transport/bot-ws/sdk-adapter.js", () => ({
  BotWsSdkAdapter: vi.fn().mockImplementation(() => {
    const adapter = { start: vi.fn(), stop: vi.fn() };
    adapters.push(adapter);
    return adapter;
  }),
}));

import { WecomBotCapabilityService } from "./service.js";

function makeRuntime() {
  const listeners = new Set<(error: Error) => void>();
  return {
    account: { accountId: "acct", bot: { configured: true, primaryTransport: "ws" } },
    onTransportFatal: (listener: (error: Error) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fatal: (name = "WSReconnectExhaustedError") => {
      for (const listener of listeners) listener(Object.assign(new Error(name), { name }));
    },
    listenerCount: () => listeners.size,
  };
}

describe("WecomBotCapabilityService WS restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    adapters.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces only the WS adapter with backoff when the SDK gives up", async () => {
    const runtime = makeRuntime();
    const service = new WecomBotCapabilityService(runtime as any, {} as any, { error: vi.fn() } as any);

    expect(service.start()?.transport).toBe("bot-ws");
    expect(adapters).toHaveLength(1);

    runtime.fatal();
    expect(adapters[0]!.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(adapters).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapters).toHaveLength(2);
    expect(adapters[1]!.start).toHaveBeenCalledTimes(1);

    // The second failure right after the restart doubles the delay.
    runtime.fatal("WSAuthFailureError");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(adapters).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapters).toHaveLength(3);
  });

  it("cancels a pending restart and stops listening when the service stops", async () => {
    const runtime = makeRuntime();
    const service = new WecomBotCapabilityService(runtime as any, {} as any, { error: vi.fn() } as any);
    service.start();

    runtime.fatal();
    service.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(adapters).toHaveLength(1);
    expect(runtime.listenerCount()).toBe(0);
  });

  it("gives up after ten failed restarts and logs it", async () => {
    const runtime = makeRuntime();
    const error = vi.fn();
    const service = new WecomBotCapabilityService(runtime as any, {} as any, { error } as any);
    service.start();

    for (let attempt = 1; attempt <= 11; attempt += 1) {
      runtime.fatal();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    }

    expect(adapters).toHaveLength(11);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain("restart-gave-up");
    service.stop();
  });
});
