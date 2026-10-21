import {
  asNullableObjectRecord,
  asNullableRecord,
  isStringArray,
} from "@openclaw/normalization-core/record-coerce";
import type { ConfigSnapshot } from "../api/types.ts";

export function isPluginEnabledInConfigSnapshot(
  configSnapshot: ConfigSnapshot | null | undefined,
  pluginId: string,
): boolean {
  const config = asNullableRecord(configSnapshot?.config);
  if (!config) {
    return false;
  }

  const plugins = asNullableObjectRecord(config.plugins);
  if (plugins?.enabled === false) {
    return false;
  }

  const deny = isStringArray(plugins?.deny) ? plugins.deny : [];
  if (deny.includes(pluginId)) {
    return false;
  }

  const allow = isStringArray(plugins?.allow) ? plugins.allow : [];
  if (allow.length > 0 && !allow.includes(pluginId)) {
    return false;
  }

  const entries = asNullableObjectRecord(plugins?.entries);
  return asNullableRecord(entries?.[pluginId])?.enabled === true;
}
