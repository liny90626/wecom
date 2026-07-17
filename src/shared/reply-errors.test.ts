import { describe, expect, it } from "vitest";
import {
  isReplySessionInitializationConflict,
  isRetryableReplySessionAdmissionError,
} from "./reply-errors.js";

describe("reply session admission error matchers", () => {
  const sessionKey = "agent:main:wecom:direct:linky";

  it("matches the 6.11 init conflict message", () => {
    const error = new Error(`reply session initialization conflicted for ${sessionKey}`);
    expect(isReplySessionInitializationConflict(error)).toBe(true);
    expect(isRetryableReplySessionAdmissionError(error)).toBe(true);
  });

  it("matches the 2026.7.1 rollover drain timeout message", () => {
    expect(
      isRetryableReplySessionAdmissionError(
        new Error(`timed out draining work before reply session rollover: ${sessionKey}`),
      ),
    ).toBe(true);
  });

  it("matches both 2026.7.1 session-work admission variants", () => {
    expect(
      isRetryableReplySessionAdmissionError(
        new Error(`Session "${sessionKey}" changed while starting work. Retry.`),
      ),
    ).toBe(true);
    expect(
      isRetryableReplySessionAdmissionError(
        new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`),
      ),
    ).toBe(true);
  });

  it("matches errors nested in cause chains and plain strings", () => {
    const nested = new Error("OpenClaw dispatch failed", {
      cause: new Error("wrapper", {
        cause: new Error(`Session "${sessionKey}" changed while starting work. Retry.`),
      }),
    });
    expect(isRetryableReplySessionAdmissionError(nested)).toBe(true);
    expect(
      isRetryableReplySessionAdmissionError(
        `reply session initialization conflicted for ${sessionKey}`,
      ),
    ).toBe(true);
  });

  it("rejects near-miss messages", () => {
    expect(
      isRetryableReplySessionAdmissionError(
        new Error(`Session "${sessionKey}" changed while starting work.`),
      ),
    ).toBe(false);
    expect(
      isRetryableReplySessionAdmissionError(
        new Error(`prefix: Session "${sessionKey}" changed while starting work. Retry.`),
      ),
    ).toBe(false);
    expect(
      isRetryableReplySessionAdmissionError(new Error("session file locked (timeout 3000ms)")),
    ).toBe(false);
    expect(isReplySessionInitializationConflict(new Error("some other failure"))).toBe(false);
  });
});
