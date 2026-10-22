import type {
  ControlUiAction,
  ControlUiAccessory,
  ControlUiHost,
  ControlUiNavigationItem,
  ControlUiPage,
  ControlUiPanel,
  ControlUiReplacement,
  ControlUiWidget,
} from "../../../src/plugin-sdk/control-ui.js";
import type { ControlUiPluginRuntime } from "./control-ui-runtime.ts";

export type ControlUiRegistration<T> = {
  key: `${string}/${string}`;
  pluginId: string;
  value: T;
  host: ControlUiHost;
  signal: AbortSignal;
};

export type ControlUiContributions = {
  pages: ControlUiPage;
  navigation: ControlUiNavigationItem;
  panels: ControlUiPanel;
  actions: ControlUiAction;
  accessories: ControlUiAccessory;
  widgets: ControlUiWidget;
  replacements: ControlUiReplacement;
};

// Keep activation and lifecycle operations private to the runtime.
export type ControlUiPluginCapability = Pick<
  ControlUiPluginRuntime,
  | "loadSettingsView"
  | "errors"
  | "hasPlugins"
  | "revision"
  | "registryStatus"
  | "canReload"
  | "isLoading"
  | "reload"
  | "subscribe"
  | "registrations"
  | "selectedReplacement"
  | "selectReplacement"
  | "reportError"
> & { refresh: () => Promise<void> };
