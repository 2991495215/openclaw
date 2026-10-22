import { For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  ChatMachineFacts,
  createChatMachinePresentation,
  type ChatPanePlacementProps,
} from "./chat-pane-placement.tsx";
import "./chat-machine.css";

export type ChatMachineProps = ChatPanePlacementProps;

/** Mobile body only. Its native host owns Back, expansion, navigation and effects. */
export function ChatMachine(props: ChatMachineProps) {
  const state = createChatMachinePresentation(props);
  const actions = (recovery: boolean) => (
    <div class="chat-machine__actions">
      <For
        each={state()?.actions.filter(
          (action) => action.visible && (!recovery || action.id !== "reclaim"),
        )}
      >
        {(action) => (
          <div>
            <button
              type="button"
              class={[
                "chat-machine__action",
                {
                  "chat-machine__action--stop": action.id === "reclaim",
                  "chat-machine__action--continue": recovery,
                },
              ]}
              disabled={Boolean(action.disabledReason) || !action.onClick}
              title={action.disabledReason}
              aria-description={action.disabledReason}
              onClick={action.onClick}
            >
              <Icon name={action.icon} />
              {action.id === "reclaim"
                ? t("sessionsView.stopWorkerConfirmAction")
                : action.label.replace(/…$/, "")}
            </button>
          </div>
        )}
      </For>
    </div>
  );
  return (
    <Show when={state()}>
      {(view) => (
        <section class={["chat-machine", { "chat-machine--offline": view().deviceOffline }]}>
          <header class="chat-machine__identity">
            <Icon name={view().machineIcon} />
            <strong>{view().machineName}</strong>
            <span class="chat-machine__connection">
              <Show when={view().placementState === "active" && !view().deviceOffline}>
                <i />
              </Show>
              {view().deviceOffline
                ? t("sessionsView.machineOffline")
                : view().placementState === "active"
                  ? t("sessionsView.machineConnected")
                  : view().placementState === "local"
                    ? t("sessionsView.machineLocal")
                    : view().label}
            </span>
          </header>
          <Show when={view().deviceOffline}>{actions(true)}</Show>
          <Show when={view().deviceOffline} fallback={<ChatMachineFacts view={view()} includeId />}>
            <section class="chat-machine__facts-group">
              <h3>{t("sessionsView.machineConfiguration")}</h3>
              <ChatMachineFacts view={view()} group="configuration" includeId />
            </section>
            <section class="chat-machine__facts-group">
              <h3>{t("sessionsView.machineLastKnownState")}</h3>
              <ChatMachineFacts view={view()} group="state" />
            </section>
          </Show>
          <Show when={!view().deviceOffline}>{actions(false)}</Show>
        </section>
      )}
    </Show>
  );
}
