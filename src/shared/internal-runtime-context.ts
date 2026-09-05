/**
 * OpenClaw fences the runtime context it generates for a turn (chat id,
 * message id, timestamps…) between these two delimiters and tells the model the
 * fenced text is "runtime-generated, not user-authored". Verified against both
 * supported lines (2026.7.1-2 and 2026.8.2), that has two consequences for a
 * channel plugin, and neither of the core's own helpers is exported through a
 * public plugin-sdk subpath, hence the local copies:
 *
 * - Inbound: `resolveRuntimeContextPromptParts` lifts any fenced block out of
 *   the prompt and hands it to the model as trusted runtime context. The core
 *   escapes the untrusted text it embeds itself (subagent results, MCP app
 *   context) but not channel inbound, so a WeCom user typing the two delimiter
 *   lines could forge context. We escape the way the core does.
 * - Outbound: `sanitizeUserFacingText` strips the fence from blocks and finals,
 *   but CLI-backend commentary (our process steps) and reasoning are forwarded
 *   untouched, so a model that narrates or quotes its runtime context would put
 *   it in the bubble.
 *
 * As in the core, a delimiter counts only when it stands on its own line.
 */

const BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const ESCAPED_BEGIN = "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]";
const ESCAPED_END = "[[OPENCLAW_INTERNAL_CONTEXT_END]]";

/** A delimiter on a line of its own (surrounding blanks allowed); the tokens contain no regex metacharacters. */
const tokenLine = (token: string): string => `(?:^|\\r?\\n)[ \\t]*${token}[ \\t]*(?=\\r?\\n|$)`;
const FENCED_BLOCK_RE = new RegExp(`${tokenLine(BEGIN)}[\\s\\S]*?${tokenLine(END)}`, "g");
const OPEN_FENCE_RE = new RegExp(tokenLine(BEGIN));
const STRAY_END_RE = new RegExp(tokenLine(END), "g");

/** Neutralise the delimiters in untrusted text before it becomes a prompt. */
export function escapeInternalRuntimeContextDelimiters(text: string): string {
  return text.replaceAll(BEGIN, ESCAPED_BEGIN).replaceAll(END, ESCAPED_END);
}

/**
 * Remove fenced runtime-context blocks from model output bound for the user.
 * An opening fence that never closes drops everything after it, as the core's
 * own stripper does: what follows is the context, not the answer.
 */
export function stripInternalRuntimeContext(text: string): string {
  if (!text.includes(BEGIN) && !text.includes(END)) {
    return text;
  }
  let next = text.replace(FENCED_BLOCK_RE, "");
  const open = OPEN_FENCE_RE.exec(next);
  if (open) {
    next = next.slice(0, open.index);
  }
  return next.replace(STRAY_END_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}
