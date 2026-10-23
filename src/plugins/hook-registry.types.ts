import type { HookEntry } from "../hooks/types.js";
import type { PluginHookRegistration as TypedPluginHookRegistration } from "./hook-types.js";

/** Hook runner registry state for legacy and typed plugin hooks. */
export type HookRunnerRegistry = {
  /** Legacy hook registration stored by the global hook runner registry. */
  hooks: {
    pluginId: string;
    entry: HookEntry;
    events: string[];
    source: string;
    rootDir?: string;
  }[];
  typedHooks: TypedPluginHookRegistration[];
};

/** Global hook runner registry snapshot with plugin load status. */
export type GlobalHookRunnerRegistry = HookRunnerRegistry & {
  plugins: Array<{
    id: string;
    packageVersion?: string;
    status: "loaded" | "disabled" | "error";
  }>;
};
