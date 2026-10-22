import { createMemo, For, onSettled, Show } from "solid-js";
import { GatewayRequestError } from "../../../api/gateway.ts";
import { isRetryableGatewayReadError } from "../../../lib/gateway-errors.ts";
import type { createGatewayRetryOwner } from "../../../lib/gateway-retry.ts";
import { listen } from "../../../lib/reactive/listener.ts";

/** The request owns the deadline; presentation only pauses and resumes it. */
export function SessionDiffReadRecovery(props: {
  error: unknown;
  active: boolean;
  canRead?: () => boolean;
  retry: ReturnType<typeof createGatewayRetryOwner>;
  onRetry: () => void;
}) {
  const failure = createMemo(() =>
    isRetryableGatewayReadError(props.error, "sessions.diff") ? { error: props.error } : undefined,
  );
  return (
    <Show when={failure()} keyed>
      {(currentFailure) => {
        onSettled(() => () => props.retry.cancel());
        return (
          <For each={[props.active]}>
            {(active) => {
              onSettled(() => {
                if (!props.retry.resume()) {
                  props.retry.schedule(
                    props.onRetry,
                    currentFailure.error instanceof GatewayRequestError
                      ? currentFailure.error.retryAfterMs
                      : undefined,
                  );
                }
                const sync = () => {
                  if (
                    active &&
                    document.visibilityState !== "hidden" &&
                    props.canRead?.() !== false
                  ) {
                    props.retry.resume();
                  } else {
                    props.retry.pause();
                  }
                };
                const stop = listen(document, "visibilitychange", sync);
                sync();
                return () => {
                  stop();
                  props.retry.pause();
                };
              });
              return null;
            }}
          </For>
        );
      }}
    </Show>
  );
}
