const REPLY_SESSION_INIT_CONFLICT_RE =
  /^reply session initialization conflicted for \S+$/iu;

export function isReplySessionInitializationConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current != null; depth += 1) {
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "string"
          ? current
          : "";
    if (REPLY_SESSION_INIT_CONFLICT_RE.test(message.trim())) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}
