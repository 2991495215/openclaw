import { For, Show, createMemo } from "solid-js";
import type { CronJob } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuControls } from "../../../components/solid/menu.tsx";
import { PanelFeedback, PanelFeedbackScope } from "../../../components/solid/panel-feedback.tsx";
import { SettingsToggle } from "../../../components/solid/settings-ui.tsx";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type {
  CiAutomationOption,
  CiAutomationOptions,
} from "../../../lib/session-pr-automation-spec.ts";
import type { CiAutomationJobs } from "../../../lib/session-pr-automation.ts";

registerEnglishCatalog(registerChatCiEnglish);

export type ChatCiAutomationProps = {
  options: CiAutomationOptions;
  pending: Partial<CiAutomationOptions>;
  jobs?: CiAutomationJobs;
  schedulerEnabled?: boolean;
  presented?: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  disabled?: boolean;
  disabledReason?: string;
  retryDisabled?: boolean;
  menuPresentation?: boolean;
  controls?: MenuControls;
  onChange: (option: CiAutomationOption, enabled: boolean) => void;
  onRetry: () => void;
};
const OPTIONS = [
  ["autoFix", "chat.pullRequests.automationAutoFix"],
  ["autoMerge", "chat.pullRequests.automationAutoMerge"],
  ["autoArchive", "chat.pullRequests.automationAutoArchive"],
] as const;
const MENU_OPTIONS = {
  autoFix: { icon: "wrench", descriptionKey: "chat.pullRequests.automationAutoFixDescription" },
  autoMerge: {
    icon: "gitMerge",
    descriptionKey: "chat.pullRequests.automationAutoMergeDescription",
  },
  autoArchive: {
    icon: "archive",
    descriptionKey: "chat.pullRequests.automationAutoArchiveDescription",
  },
} as const;

function JobError(props: { label: string; job?: CronJob }) {
  const message = () => {
    const disabled = props.job?.state.autoDisabled;
    const error = props.job?.state.lastError;
    return [
      disabled
        ? t(
            disabled.reason === "schedule-errors"
              ? "chat.pullRequests.automationScheduleDisabled"
              : "chat.pullRequests.automationFailureDisabled",
            { count: String(disabled.consecutiveErrors) },
          )
        : undefined,
      error ? t("chat.pullRequests.automationLastError", { error }) : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  };
  return <PanelFeedback label={props.label} message={message()} />;
}

export function ChatCiAutomationView(props: ChatCiAutomationProps) {
  return (
    <PanelFeedbackScope presented={props.presented}>
      <div class="chat-ci__automation">
        <fieldset
          class="chat-ci__automation-options"
          aria-label={t("chat.pullRequests.automationLabel")}
          disabled={props.disabled}
        >
          <For each={OPTIONS}>
            {(entry) => {
              const inputRef = createMemo(() => props.controls?.ref());
              return (
                <div class="chat-ci__automation-row">
                  <Show
                    when={props.menuPresentation}
                    fallback={
                      <label class="chat-ci__automation-option">
                        <input
                          ref={inputRef()}
                          class="chat-ci__automation-checkbox"
                          type="checkbox"
                          name={entry[0]}
                          checked={props.options[entry[0]]}
                          disabled={props.pending[entry[0]] !== undefined}
                          onChange={(event) =>
                            props.onChange(entry[0], event.currentTarget.checked)
                          }
                        />
                        <span class="chat-ci__automation-label">{t(entry[1])}</span>
                      </label>
                    }
                  >
                    <label class="chat-ci__automation-option chat-ci__automation-option--menu">
                      <Icon name={MENU_OPTIONS[entry[0]].icon} />
                      <span class="chat-ci__automation-label">
                        {t(
                          entry[0] === "autoArchive"
                            ? "chat.pullRequests.automationAutoArchiveSession"
                            : entry[1],
                        )}
                        <span class="chat-ci__automation-description">
                          {t(MENU_OPTIONS[entry[0]].descriptionKey)}
                        </span>
                      </span>
                      <SettingsToggle
                        inputRef={inputRef()}
                        ariaLabel={t(
                          entry[0] === "autoArchive"
                            ? "chat.pullRequests.automationAutoArchiveSession"
                            : entry[1],
                        )}
                        checked={props.options[entry[0]]}
                        disabled={props.disabled || props.pending[entry[0]] !== undefined}
                        onChange={(enabled) => props.onChange(entry[0], enabled)}
                      />
                    </label>
                  </Show>
                  <JobError label={t(entry[1])} job={props.jobs?.[entry[0]]} />
                </div>
              );
            }}
          </For>
        </fieldset>
        <PanelFeedback
          label={t("chat.pullRequests.ciMonitoring")}
          message={
            props.schedulerEnabled === false
              ? t("chat.pullRequests.automationSchedulerDisabled")
              : undefined
          }
        />
        <PanelFeedback label={t("chat.pullRequests.ciMonitoring")} message={props.disabledReason} />
        <PanelFeedback
          label={t("chat.pullRequests.ciMonitoring")}
          message={props.error}
          onRetry={() => props.onRetry()}
          retryDisabled={props.retryDisabled}
          retrying={props.loading || props.saving}
        />
      </div>
    </PanelFeedbackScope>
  );
}
