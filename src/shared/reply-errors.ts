const REPLY_SESSION_INIT_CONFLICT_RE =
  /^reply session initialization conflicted for \S+$/iu;

// OpenClaw ≥2026.7.1 raises these from session-work admission before the agent
// run starts (core's own copy ends in "Retry."), so one bounded retry after a
// drain is safe and cannot repeat tools.
const RETRYABLE_REPLY_SESSION_ADMISSION_RES = [
  REPLY_SESSION_INIT_CONFLICT_RE,
  /^timed out draining work before reply session rollover: \S+$/iu,
  /^Session "[^"]*" (?:changed|was deleted) while starting work\. Retry\.$/iu,
];

function matchesReplyErrorMessage(error: unknown, patterns: readonly RegExp[]): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current != null; depth += 1) {
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "string"
          ? current
          : "";
    const trimmed = message.trim();
    if (patterns.some((pattern) => pattern.test(trimmed))) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

export function isReplySessionInitializationConflict(error: unknown): boolean {
  return matchesReplyErrorMessage(error, [REPLY_SESSION_INIT_CONFLICT_RE]);
}

export function isRetryableReplySessionAdmissionError(error: unknown): boolean {
  return matchesReplyErrorMessage(error, RETRYABLE_REPLY_SESSION_ADMISSION_RES);
}
