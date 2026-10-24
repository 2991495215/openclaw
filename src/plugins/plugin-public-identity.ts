import {
  getOfficialExternalPluginCatalogEntryForPackage,
  isOfficialExternalPluginId,
  resolveOfficialExternalPluginId,
} from "./official-external-plugin-catalog.js";
import type { PluginRecord } from "./registry-types.js";

/** True when a plugin identity is already public and safe to report. */
export function isPubliclyKnownPluginId(
  plugin: Pick<PluginRecord, "id" | "origin" | "packageName" | "trustedOfficialInstall">,
): boolean {
  if (plugin.origin === "bundled" || plugin.trustedOfficialInstall === true) {
    return true;
  }
  if (!isOfficialExternalPluginId(plugin.id)) {
    return false;
  }
  const catalogEntry = getOfficialExternalPluginCatalogEntryForPackage(plugin.packageName);
  return catalogEntry !== undefined && resolveOfficialExternalPluginId(catalogEntry) === plugin.id;
}
