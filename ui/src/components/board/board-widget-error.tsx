import { Show } from "solid-js";
import { registerBoardEnglish } from "../../i18n/locales/en-board.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerBoardEnglish);

export function BoardWidgetError(props: { error: unknown; onRetry?: () => void }) {
  return (
    <div class="board-widget__error" role="alert" data-test-id="board-widget-error">
      <strong>{t("board.widget.errorTitle")}</strong>
      <span>{t("board.widget.errorDetail")}</span>
      <details>
        <summary>{t("board.widget.errorShow")}</summary>
        <code>{formatUiError(props.error)}</code>
      </details>
      <Show when={props.onRetry}>
        <button class="btn btn--small" type="button" onClick={() => props.onRetry?.()}>
          {t("board.widget.retry")}
        </button>
      </Show>
    </div>
  );
}
