import type { JSX } from "@solidjs/web";
import { action, createOptimistic } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";

export type AgentConfigActions = {
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  canUpdateConfig: boolean;
  onConfigReload: () => void | Promise<unknown>;
  onConfigSave: () => void | Promise<unknown>;
};

export function AgentConfigButtons(
  props: AgentConfigActions & { children?: JSX.Element; buttonType?: "button" },
) {
  const [pending, setPending] = createOptimistic<"reload" | "save" | null>(null);
  const command = action(function* (operation: "reload" | "save") {
    setPending(operation);
    yield operation === "reload" ? props.onConfigReload() : props.onConfigSave();
  });
  return (
    <>
      <button
        type={props.buttonType}
        class="btn btn--sm"
        disabled={pending() !== null || props.configLoading}
        onClick={() => void command("reload")}
      >
        {t("common.reloadConfig")}
      </button>
      {props.children}
      <button
        type={props.buttonType}
        class="btn btn--sm primary"
        disabled={
          !props.canUpdateConfig || pending() !== null || props.configSaving || !props.configDirty
        }
        onClick={() => void command("save")}
      >
        {t(pending() === "save" || props.configSaving ? "common.saving" : "common.save")}
      </button>
    </>
  );
}
