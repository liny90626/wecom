# WeCom B2/B3 Delivery Validation

## Scope

This document tracks the Bot WS delivery fixes maintained in the LinKy fork.
B2 covers long final text delivery and deduplication. B3 covers long tasks and
Bot WS replies that are superseded by a newer inbound message from the same
account and peer.

Normal final replies must keep the B2 delivery path:

1. `replyStream(..., finish=true)` closes the original thinking placeholder with
   the first final chunk.
2. Additional long-message chunks are sent with Bot WS active push.
3. Repeated preview/final tails are deduplicated before delivery.

B3 must not overwrite user-visible text:

1. If the old stream still only shows the placeholder, it may be closed with
   `已收到新消息，合并思考。✅`.
2. If the old stream has already shown real text, do not replace that text with
   the merge notice.
3. If the original stream window expires before final delivery, send the final
   result through active push.

Reasoning preview is experimental and separate from B2/B3. It may render a
WeCom thinking block when OpenClaw/provider reasoning content reaches the Bot
WS progress stream.

## Local Checks

Run from the repository root:

```bash
npm run build
node scripts/patch-wecom-markdown-table.mjs --check
node scripts/patch-wecom-long-message.mjs --check
node scripts/patch-wecom-b3-merge-thinking.mjs --check
npx vitest run src/app/index.test.ts src/transport/bot-ws/reply.test.ts
npx vitest run
```

Expected results:

- B1 check returns `status: "READY"`.
- B2 check returns `status: "READY"`.
- B3 check returns `status: "READY"`.
- `src/app/index.test.ts` proves that registering a newer same-peer Bot WS
  handle calls `supersedeByNewInbound` on the previous handle.
- `src/transport/bot-ws/reply.test.ts` covers placeholder-only supersede,
  visible-text supersede, expired long-task final delivery, repeated
  final/preview deduplication, and Markdown table protection.
- The newer same-peer reply still uses the normal B2 final stream path.

## Manual Bot WS Acceptance

Use a real WeCom Bot WS account with the rebuilt plugin loaded.

1. Send message A to the bot.
2. Before A produces a final answer, send message B in the same direct chat or
   group.
3. If A has not produced visible text yet, confirm A's original thinking bubble
   is closed with:
   `已收到新消息，合并思考。✅`
4. If A has already produced visible text, confirm that visible text remains and
   is not replaced by the merge notice.
5. Let both replies finish.
6. Confirm the visible result has exactly one A final answer and exactly one B
   final answer.
7. Confirm B's final answer replaces its own thinking bubble instead of being
   delivered as an extra full active-push bubble.
8. For long tasks, confirm preview text freezes after the configured threshold
   and status updates continue without re-sending large body text.
9. Check logs for `[wecom-b3] superseded`, `[wecom-b3] supersede-notice`,
   `[wecom-b3] superseded-final`, one active-push/client-push chunk series for
   expired old streams, and `[wecom-b3] stream-final` for normal B delivery.

Known boundary: attachments on a superseded final are not re-uploaded from the
old stream. The user-visible fallback text asks the user to resend or confirm
the file when media is present.
