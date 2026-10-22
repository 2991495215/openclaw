import { createMemo, Errored, Show } from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function McpOperationOutcome(props: {
  operation?: { result: Promise<null> } | null;
  onRetry?: () => void;
}) {
  return (
    <Show when={props.operation} keyed>
      {(admitted) => {
        const outcome = createMemo(() => admitted.result, { loadingValue: null });
        return (
          <Errored
            fallback={(error) => (
              <>
                <p role="alert">{formatUiError(error())}</p>
                <Show when={props.onRetry}>
                  <button class="btn" onClick={() => props.onRetry?.()}>
                    {t("mcpApp.retry")}
                  </button>
                </Show>
              </>
            )}
          >
            {outcome()}
          </Errored>
        );
      }}
    </Show>
  );
}
