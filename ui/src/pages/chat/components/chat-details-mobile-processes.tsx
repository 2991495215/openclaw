import { For, Show, createMemo } from "solid-js";
import { PanelFeedback } from "../../../components/solid/panel-feedback.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerProcessesEnglish } from "../../../i18n/locales/en-processes.ts";
import { registerSessionOrganizationEnglish } from "../../../i18n/locales/en-session-organization.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";
import { ChatDetailsProcessRow } from "./chat-details-process-row.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

registerEnglishCatalog(registerProcessesEnglish);
registerEnglishCatalog(registerSessionOrganizationEnglish);

export type ChatDetailsMobileProcessesProps = {
  /** The session host retains the native ProcessesPanelData projection and its demand. */
  data: Pick<ProcessesPanelData["snapshot"], "rows" | "error" | "errorKind" | "loading"> &
    Pick<ProcessesPanelData, "refresh">;
  presented: boolean;
  onOpen?: () => void;
};

const order = { running: 0, failed: 1, killed: 2, completed: 3 } as const;

/** Two native process rows; the existing host opens the complete collection. */
export function ChatDetailsMobileProcesses(props: ChatDetailsMobileProcessesProps) {
  const rows = createMemo(() =>
    props.data.rows.toSorted((a, b) => order[a.status] - order[b.status]),
  );
  return (
    <div class="chat-details-mobile-processes">
      <PanelFeedback
        label={t("chat.sessionDetails.processes")}
        message={props.data.errorKind === "access" ? props.data.error : undefined}
        onRetry={() => void props.data.refresh()}
        retrying={props.data.loading}
        presented={props.presented}
      />
      <div role="list" aria-label={t("chat.sessionDetails.processes")}>
        <For each={rows().slice(0, 2)} keyed={(row) => row.instanceId}>
          {(row) => (
            <ChatDetailsProcessRow row={row()} disabled={!props.presented} onOpen={props.onOpen} />
          )}
        </For>
      </div>
      <Show when={props.onOpen}>
        <button
          type="button"
          class="chat-details-mobile-root__entry chat-details-mobile-processes__show-all"
          disabled={!props.presented}
          onClick={() => props.onOpen?.()}
        >
          <span class="chat-details-mobile-root__copy">{t("sessionsView.showAll")}</span>
        </button>
      </Show>
    </div>
  );
}
