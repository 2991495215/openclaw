import { For, Show, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuControls } from "../../../components/solid/menu.tsx";
import { SettingsToggle } from "../../../components/solid/settings-ui.tsx";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type {
  CiAutomationOption,
  CiAutomationOptions,
} from "../../../lib/session-pr-automation-spec.ts";

registerEnglishCatalog(registerChatCiEnglish);

export type ChatCiAutomationProps = {
  options: CiAutomationOptions;
  pending: Partial<CiAutomationOptions>;
  loading: boolean;
  saving: boolean;
  disabled?: boolean;
  disabledReason?: string;
  menuPresentation?: boolean;
  controls?: MenuControls;
  onChange: (option: CiAutomationOption, enabled: boolean) => void;
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

export function ChatCiAutomationView(props: ChatCiAutomationProps) {
  return (
    <div class="chat-ci__automation">
      <fieldset
        aria-busy={props.loading || props.saving ? "true" : "false"}
        class="chat-ci__automation-options"
        aria-label={t("chat.pullRequests.automationLabel")}
        aria-description={props.disabledReason}
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
                        onChange={(event) => props.onChange(entry[0], event.currentTarget.checked)}
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
              </div>
            );
          }}
        </For>
      </fieldset>
    </div>
  );
}
