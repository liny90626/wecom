import type { PluginRuntime } from "openclaw/plugin-sdk";

const DEFAULT_INBOUND_SESSION_METADATA_TIMEOUT_MS = 60_000;

type RecordInboundSessionParams = Omit<
  Parameters<PluginRuntime["channel"]["session"]["recordInboundSession"]>[0],
  "trackSessionMetaTask"
>;

function createMetadataTimeoutError(timeoutMs: number): Error {
  const error = new Error(`WeCom inbound session metadata timed out after ${timeoutMs}ms`);
  error.name = "WeComInboundSessionMetadataTimeoutError";
  return error;
}

function waitWithAbortAndTimeout<T>(params: {
  promise: Promise<T>;
  abortSignal?: AbortSignal;
  timeoutMs: number;
}): Promise<T> {
  const { promise, abortSignal, timeoutMs } = params;
  if (abortSignal?.aborted) {
    return Promise.reject(abortSignal.reason ?? new Error("WeCom inbound session aborted."));
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let handleAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(createMetadataTimeoutError(timeoutMs)), timeoutMs);
    timeout.unref?.();
  });
  const abortPromise = new Promise<never>((_, reject) => {
    if (!abortSignal) return;
    handleAbort = () =>
      reject(abortSignal.reason ?? new Error("WeCom inbound session aborted."));
    abortSignal.addEventListener("abort", handleAbort, { once: true });
  });
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    if (abortSignal && handleAbort) {
      abortSignal.removeEventListener("abort", handleAbort);
    }
  };
  return Promise.race([promise, timeoutPromise, abortPromise]).finally(cleanup);
}

export async function recordInboundSessionSettled(
  core: PluginRuntime,
  params: RecordInboundSessionParams,
  options: {
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    waitForMetadata?: boolean;
    onMetadataTimeout?: (error: Error) => void;
  } = {},
): Promise<void> {
  if (options.abortSignal?.aborted) {
    throw options.abortSignal.reason ?? new Error("WeCom inbound session aborted.");
  }
  const metadataTasks: Promise<unknown>[] = [];
  await core.channel.session.recordInboundSession({
    ...params,
    trackSessionMetaTask: (task) => {
      metadataTasks.push(task);
    },
  });
  if (metadataTasks.length === 0) {
    return;
  }
  const operation = Promise.allSettled(metadataTasks);
  if (options.waitForMetadata === false) {
    return;
  }
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_INBOUND_SESSION_METADATA_TIMEOUT_MS;

  try {
    await waitWithAbortAndTimeout({
      promise: operation,
      abortSignal: options.abortSignal,
      timeoutMs,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "WeComInboundSessionMetadataTimeoutError" &&
      options.onMetadataTimeout
    ) {
      options.onMetadataTimeout(error);
      return;
    }
    throw error;
  }
}
