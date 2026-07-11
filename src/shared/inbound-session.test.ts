import { describe, expect, it, vi } from "vitest";

import { recordInboundSessionSettled } from "./inbound-session.js";

function makeParams() {
  return {
    storePath: "/tmp/wecom-inbound-session-test",
    sessionKey: "agent:ops_bot:wecom:direct:alice",
    ctx: { SessionKey: "agent:ops_bot:wecom:direct:alice" },
    onRecordError: vi.fn(),
  };
}

describe("recordInboundSessionSettled", () => {
  it("waits for every tracked metadata write before returning", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const recordInboundSession = vi.fn(async (params) => {
      params.trackSessionMetaTask?.(first);
      params.trackSessionMetaTask?.(second);
    });
    const operation = recordInboundSessionSettled(
      { channel: { session: { recordInboundSession } } } as any,
      makeParams(),
    );
    let settled = false;
    void operation.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(recordInboundSession).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSecond();
    await operation;
    expect(settled).toBe(true);
  });

  it("keeps tracked metadata failures non-blocking after they settle", async () => {
    const metadataError = new Error("metadata write failed");
    const recordInboundSession = vi.fn(async (params) => {
      params.trackSessionMetaTask?.(Promise.reject(metadataError));
    });

    await expect(
      recordInboundSessionSettled(
        { channel: { session: { recordInboundSession } } } as any,
        makeParams(),
      ),
    ).resolves.toBeUndefined();
  });

  it("stops waiting when the caller aborts", async () => {
    const metadataTask = new Promise<void>(() => undefined);
    const recordInboundSession = vi.fn(async (params) => {
      params.trackSessionMetaTask?.(metadataTask);
    });
    const abortController = new AbortController();
    const abortReason = new Error("superseded");
    const operation = recordInboundSessionSettled(
      { channel: { session: { recordInboundSession } } } as any,
      makeParams(),
      { abortSignal: abortController.signal },
    );

    await vi.waitFor(() => expect(recordInboundSession).toHaveBeenCalledTimes(1));
    abortController.abort(abortReason);

    await expect(operation).rejects.toBe(abortReason);
  });

  it("does not start recording when already aborted", async () => {
    const abortController = new AbortController();
    const abortReason = new Error("already superseded");
    abortController.abort(abortReason);
    const recordInboundSession = vi.fn();

    await expect(
      recordInboundSessionSettled(
        { channel: { session: { recordInboundSession } } } as any,
        makeParams(),
        { abortSignal: abortController.signal },
      ),
    ).rejects.toBe(abortReason);
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("times out instead of waiting forever for metadata", async () => {
    vi.useFakeTimers();
    try {
      const metadataTask = new Promise<void>(() => undefined);
      const recordInboundSession = vi.fn(async (params) => {
        params.trackSessionMetaTask?.(metadataTask);
      });
      const operation = recordInboundSessionSettled(
        { channel: { session: { recordInboundSession } } } as any,
        makeParams(),
        { timeoutMs: 100 },
      );
      const rejected = expect(operation).rejects.toMatchObject({
        name: "WeComInboundSessionMetadataTimeoutError",
      });

      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
