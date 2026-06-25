# WeCom B3 Merge-Thinking Validation

## Scope

B3 only handles Bot WS replies that are superseded by a newer inbound message
from the same account and peer. Normal final replies must keep the B2 delivery
path:

1. `replyStream(..., finish=true)` closes the original thinking placeholder with
   the first final chunk.
2. Additional long-message chunks are sent with `sendMessage`.

## Local Checks

Run from the repository root:

```bash
npm run build
node scripts/patch-wecom-long-message.mjs --check
node scripts/patch-wecom-b3-merge-thinking.mjs --check
npx vitest run src/app/index.test.ts src/transport/bot-ws/reply.test.ts
npx vitest run
```

Expected results:

- B2 check returns `status: "READY"`.
- B3 check returns `status: "READY"`.
- `src/app/index.test.ts` proves that registering a newer same-peer Bot WS
  handle calls `supersedeByNewInbound` on the previous handle.
- `src/transport/bot-ws/reply.test.ts` proves that the superseded old reply
  closes its thinking placeholder with `已收到新消息，合并思考。✅`, then sends the old
  final through Bot WS active push without updating the old stream.
- The newer same-peer reply still uses the normal B2 final stream path.

## Manual Bot WS Acceptance

Use a real WeCom Bot WS account with the rebuilt plugin loaded.

1. Send message A to the bot.
2. Before A produces a final answer, send message B in the same direct chat or
   group.
3. Confirm A's original thinking bubble is closed with:
   `已收到新消息，合并思考。✅`
4. Let both replies finish.
5. Confirm the visible result has exactly one A final answer and exactly one B
   final answer.
6. Confirm B's final answer replaces its own thinking bubble instead of being
   delivered as an extra full active-push bubble.
7. Check logs for `[wecom-b3] superseded`, `[wecom-b3] supersede-notice`,
   `[wecom-b3] superseded-final`, and one active-push/client-push chunk series
   for A. Normal B should log `[wecom-b3] stream-final`.

Known boundary: attachments on a superseded final are not re-uploaded from the
old stream. The user-visible fallback text asks the user to resend or confirm
the file when media is present.
