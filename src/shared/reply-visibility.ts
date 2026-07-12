const THINK_ONLY_REPLY_RE = /^(?:<think>[\s\S]*?<\/think>\s*)+$/i;
const INVISIBLE_FORMAT_RE = /\p{Cf}/gu;

export function hasVisibleReplyBody(
  payload: {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    isReasoning?: boolean;
    isStatusNotice?: boolean;
    isCompactionNotice?: boolean;
    isFallbackNotice?: boolean;
  },
  kind?: string,
): boolean {
  const hasMedia = Boolean(
    payload.mediaUrl?.trim() ||
    payload.mediaUrls?.some((mediaUrl) => mediaUrl.trim()),
  );
  if (hasMedia) {
    return true;
  }
  if (
    kind === "tool" ||
    payload.isReasoning === true ||
    payload.isStatusNotice === true ||
    payload.isCompactionNotice === true ||
    payload.isFallbackNotice === true
  ) {
    return false;
  }
  const text = payload.text?.replace(INVISIBLE_FORMAT_RE, "").trim() ?? "";
  return Boolean(text) && !THINK_ONLY_REPLY_RE.test(text);
}
