/** Minimum spacing between consecutive Agent messages to preserve client order. */
export const MIN_CHUNK_SEND_SPACING_MS = 1_100;

export type SendPacer = () => Promise<void>;

export function createSendPacer(spacingMs: number = MIN_CHUNK_SEND_SPACING_MS): SendPacer {
  let previousSendAt: number | undefined;

  return async function pace(): Promise<void> {
    if (previousSendAt !== undefined) {
      const waitMs = previousSendAt + spacingMs - Date.now();
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    previousSendAt = Date.now();
  };
}
