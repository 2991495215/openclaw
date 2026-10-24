import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../model-catalog/index.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "../plugins/config-state.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { buildEffectiveManifestProviderConfig } from "../plugins/provider-catalog.js";
import { groupPluginRecords as groupRecords } from "../plugins/record-groups.js";

export function resolveEligibleManifestCatalogPlugins(
  snapshot: PluginMetadataSnapshot,
  config: OpenClawConfig,
): PluginMetadataSnapshot["plugins"] {
  let normalizedConfig: NormalizedPluginsConfig | undefined;
  return snapshot.plugins.filter(
    (plugin) =>
      plugin.modelCatalog &&
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config,
        normalizedConfig:
          config.plugins && (normalizedConfig ??= normalizePluginsConfig(config.plugins)),
      }),
  );
}

/**
 * Known manifest inventory for the caller's admitted providers. Captured publications show it
 * until live discovery replaces that provider's rows.
 */
export function loadManifestModelProviderConfigs(params: {
  config: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  providerIds: readonly string[];
}): Record<string, ModelProviderConfig> {
  if (params.config.models?.mode === "replace" || params.providerIds.length === 0) {
    return {};
  }
  const { rows } = planEffectiveModelCatalogRows({
    registry: {
      plugins: resolveEligibleManifestCatalogPlugins(params.metadataSnapshot, params.config),
    },
    config: params.config,
    providerFilters: params.providerIds,
  });
  // Typed-only declarations have no conversational Model defaults or registry entry.
  const rowsByProvider = groupRecords(
    rows.filter((row) => row.inference?.chat !== false),
    (row) => row.provider,
  );
  const providers: Record<string, ModelProviderConfig> = {};
  for (const [provider, providerRows] of rowsByProvider) {
    const providerConfig = buildEffectiveManifestProviderConfig(providerRows);
    if (providerConfig) {
      providers[provider] = providerConfig;
    }
  }
  return providers;
}
