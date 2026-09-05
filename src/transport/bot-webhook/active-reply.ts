import { wecomFetch } from "../../http.js";
import { LIMITS, monitorState } from "../../monitor/state.js";

const activeReplyStore = monitorState.activeReplyStore;

export function storeActiveReply(streamId: string, responseUrl?: string, proxyUrl?: string): void {
  activeReplyStore.store(streamId, responseUrl, proxyUrl);
}

export function getActiveReplyUrl(streamId: string): string | undefined {
  return activeReplyStore.getUrl(streamId);
}

export async function useActiveReplyOnce(
  streamId: string,
  fn: (params: { responseUrl: string; proxyUrl?: string }) => Promise<void>,
): Promise<void> {
  return activeReplyStore.use(streamId, async (params) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await fn(params);
  });
}

export async function sendActiveMessage(streamId: string, content: string): Promise<void> {
  await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
    const res = await wecomFetch(
      responseUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content } }),
      },
      { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
    );
    if (!res.ok) {
      throw new Error(`active send failed: ${res.status}`);
    }
  });
}
