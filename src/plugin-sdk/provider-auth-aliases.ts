// Cold configuration readers resolve credential ownership without loading auth execution.
import {
  getPreparedProviderAuthAliasSnapshot,
  resolveProviderIdForAuth as resolvePreparedProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "../agents/provider-auth-aliases.js";
import { loadLegacyPluginMetadataSnapshotRuntime } from "../plugins/plugin-metadata-snapshot-required.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";

export { resolveProviderIdForAuthAsync } from "../agents/provider-auth-aliases.js";

/** @deprecated Await resolveProviderIdForAuthAsync; removed in a later release after stable deprecation. */
export function resolveProviderIdForAuth(
  provider: string,
  params?: ProviderAuthAliasLookupParams,
): string {
  if (!provider.trim()) {
    return resolvePreparedProviderIdForAuth(provider, params);
  }
  const metadataSnapshot = getPreparedProviderAuthAliasSnapshot(params);
  if (metadataSnapshot) {
    return resolvePreparedProviderIdForAuth(provider, { ...params, metadataSnapshot });
  }
  warnPluginSdkDeprecation({
    family: "provider-auth-aliases-sync",
    method: "resolveProviderIdForAuth",
    replacement: "resolveProviderIdForAuthAsync",
    compatibility: "The synchronous helper retains cold native metadata discovery.",
  });
  return resolvePreparedProviderIdForAuth(provider, {
    ...params,
    metadataSnapshot: loadLegacyPluginMetadataSnapshotRuntime({
      config: params?.config,
      env: params?.env ?? process.env,
      workspaceDir: params?.workspaceDir,
      allowWorkspaceScopedCurrent: true,
    }),
  });
}
