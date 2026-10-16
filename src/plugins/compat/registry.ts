import { PLUGIN_COMPAT_RECORDS } from "./registry-records.js";
import type { PluginCompatRecord } from "./types.js";

export type PluginCompatCode = (typeof PLUGIN_COMPAT_RECORDS)[number]["code"];
type KnownPluginCompatRecord = PluginCompatRecord<PluginCompatCode>;

export function listPluginCompatRecords(): readonly KnownPluginCompatRecord[] {
  return PLUGIN_COMPAT_RECORDS;
}
