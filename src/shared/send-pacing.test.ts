import { describe, expect, it, vi } from "vitest";
import { createSendPacer } from "./send-pacing.js";

describe("createSendPacer", () => {
  it("spaces consecutive sends from their start times", async () => {
    vi.useFakeTimers();
    try {
      const pace = createSendPacer(1_100);
      await pace();
      const pending = pace();
      await vi.advanceTimersByTimeAsync(1_099);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
