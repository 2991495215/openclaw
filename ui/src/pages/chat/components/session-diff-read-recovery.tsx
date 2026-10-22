import type { JSX } from "@solidjs/web";
import { For, isPending, latest, Loading, onSettled, Show } from "solid-js";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { isRetryableGatewayReadError } from "../../../lib/gateway-errors.ts";
import type { createGatewayRetryOwner } from "../../../lib/gateway-retry.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";

/** The request owns recovery; presentation only pauses and resumes its deadline. */
function SessionDiffReadRecovery(props: {
  active: boolean;
  canRead?: () => boolean;
  retry: ReturnType<typeof createGatewayRetryOwner>;
}) {
  return (
    <For each={[props.active]}>
      {(active) => {
        onSettled(() => {
          const sync = () => {
            if (active && document.visibilityState !== "hidden" && props.canRead?.() !== false) {
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
}

/** Observes the admitted request; it does not issue reads or own accepted data. */
export function SessionDiffReadBoundary(props: {
  scope: unknown;
  available: boolean;
  read: () => { error: unknown } | null;
  active: boolean;
  canRead?: () => boolean;
  retry: ReturnType<typeof createGatewayRetryOwner>;
  blocked: boolean;
  awaitingDestination: boolean;
  hasValue: boolean;
  children: JSX.Element;
}) {
  return (
    <Loading
      on={props.scope}
      fallback={
        <Show when={props.available}>
          <PanelLoadingSkeleton variant="review" label={t("chat.sessionDiff.loading")} />
        </Show>
      }
    >
      <Show when={isPending(props.read) ? null : latest(props.read)}>
        <SessionDiffReadRecovery
          active={props.active}
          canRead={props.canRead}
          retry={props.retry}
        />
      </Show>
      <Show
        when={
          !isPending(props.read) &&
          ((props.blocked && props.awaitingDestination) ||
            (latest(props.read) &&
              !(
                props.hasValue &&
                !props.awaitingDestination &&
                isRetryableGatewayReadError(latest(props.read)?.error, "sessions.diff")
              )))
        }
        fallback={props.children}
      >
        {null}
      </Show>
    </Loading>
  );
}
