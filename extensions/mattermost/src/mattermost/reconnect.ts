import { setTimeout as delay } from "node:timers/promises";

type RunWithReconnectOpts = {
  abortSignal?: AbortSignal;
  onError?: (err: unknown) => void;
  onReconnect?: (delayMs: number) => void;
  reconnectAfterClose?: boolean;
};

export async function runWithReconnect(
  connectFn: () => Promise<void>,
  opts: RunWithReconnectOpts = {},
): Promise<void> {
  let retryDelay = 2000;
  while (!opts.abortSignal?.aborted) {
    let failed = false;
    try {
      await connectFn();
    } catch (err) {
      if (opts.abortSignal?.aborted) {
        return;
      }
      failed = true;
      opts.onError?.(err);
    }
    if (opts.abortSignal?.aborted) {
      return;
    }
    if (!failed) {
      retryDelay = 2000;
    }
    const delayMs = withJitter(retryDelay);
    if (!failed && opts.reconnectAfterClose === false) {
      return;
    }
    opts.onReconnect?.(delayMs);
    try {
      await delay(delayMs, undefined, { signal: opts.abortSignal });
    } catch (delayError) {
      if (!opts.abortSignal?.aborted) {
        throw delayError;
      }
    }
    if (failed) {
      retryDelay = Math.min(retryDelay * 2, 60_000);
    }
  }
}

function withJitter(baseMs: number): number {
  const normalized = Math.max(0, Math.min(1, Math.random()));
  const spread = baseMs * 0.2;
  return Math.max(1, Math.round(baseMs - spread + normalized * spread * 2));
}
