/** Normalizes durable plugin install records into installed-index metadata and back. */
import {
  createPluginInstallRecordMap,
  parsePluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type {
  InstalledPluginIndex,
  InstalledPluginInstallRecordInfo,
} from "./installed-plugin-index-types.js";

/** Normalizes raw plugin install records into index-safe install record metadata. */
export function normalizeInstallRecordMap(
  records: Record<string, PluginInstallRecord> | undefined,
): Record<string, InstalledPluginInstallRecordInfo> {
  const normalized = parsePluginInstallRecordMap(records ?? {});
  if (!normalized) {
    throw new Error("Invalid plugin install record map");
  }
  return normalized;
}

/** Copies canonical install records out of the installed index. */
export function extractPluginInstallRecordsFromInstalledPluginIndex(
  index: InstalledPluginIndex | null | undefined,
): Record<string, PluginInstallRecord> {
  const records = createPluginInstallRecordMap<PluginInstallRecord>();
  for (const [pluginId, record] of Object.entries(index?.installRecords ?? {})) {
    // Match schema parsing's copies of known structured fields; passthrough fields stay intact.
    setPluginInstallRecordMapEntry(records, pluginId, {
      ...record,
      ...(record.clawhubTrustReasons
        ? { clawhubTrustReasons: [...record.clawhubTrustReasons] }
        : {}),
      ...(record.acceptedSurface
        ? { acceptedSurface: structuredClone(record.acceptedSurface) }
        : {}),
    });
  }
  return records;
}
