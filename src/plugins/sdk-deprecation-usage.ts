import { resolveGlobalMap } from "../shared/global-singleton.js";
import { getOrCreateInnerMap } from "../shared/inner-map.js";

export type PluginSdkDeprecatedApi = {
  id: string;
  displayName: string;
  replacement: string;
  removeAfter?: string;
};

// Reloads retain observations; a new Gateway process starts with no recorded usage.
const usage = resolveGlobalMap<string, Map<string, PluginSdkDeprecatedApi>>(
  Symbol.for("openclaw.pluginSdkDeprecationUsage"),
);

export function recordPluginSdkDeprecationUsage(
  pluginId: string,
  id: string,
  displayName: string,
  replacement: string,
  removeAfter?: string,
): void {
  const recorded = getOrCreateInnerMap(usage, pluginId);
  if (!recorded.has(id)) {
    recorded.set(id, { id, displayName, replacement, ...(removeAfter ? { removeAfter } : {}) });
  }
}

export function getPluginSdkDeprecationUsage(pluginId: string): PluginSdkDeprecatedApi[] {
  return [...(usage.get(pluginId)?.values() ?? [])];
}
