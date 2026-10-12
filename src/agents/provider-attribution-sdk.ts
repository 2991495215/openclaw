import { loadLegacyPluginMetadataSnapshotRuntime } from "../plugins/plugin-metadata-snapshot-required.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";
import { getActivePluginRegistryWorkspaceDirFromStateCore } from "../plugins/runtime-workspace-state.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import {
  resolveProviderEndpoint as resolveEndpoint,
  resolveProviderRequestCapabilities as resolveCapabilities,
  resolveProviderRequestPolicy as resolvePolicy,
} from "./provider-attribution.js";

function prepareLegacyOwners(owners: PluginMetadataSnapshotOwnerMaps | undefined, method: string) {
  warnPluginSdkDeprecation({
    family: "provider-http-sync-policy",
    method,
    replacement: "prepareModelProviderRequestRouteFacts",
    compatibility: "The synchronous helpers retain cold native metadata discovery.",
  });
  return (
    owners ??
    loadLegacyPluginMetadataSnapshotRuntime({
      env: process.env,
      workspaceDir: getActivePluginRegistryWorkspaceDirFromStateCore(),
      allowWorkspaceScopedCurrent: true,
    }).owners
  );
}

/** @deprecated Await prepareModelProviderRequestRouteFacts; removed in the next Plugin SDK major. */
export function resolveProviderEndpointLegacy(
  ...[baseUrl, owners]: Parameters<typeof resolveEndpoint>
) {
  return resolveEndpoint(baseUrl, prepareLegacyOwners(owners, "resolveProviderEndpoint"));
}

/** @deprecated Await prepareModelProviderRequestRouteFacts; removed in the next Plugin SDK major. */
export function resolveProviderRequestPolicyLegacy(
  ...[input, env]: Parameters<typeof resolvePolicy>
) {
  return resolvePolicy(
    {
      ...input,
      providerMetadataOwners: prepareLegacyOwners(
        input.providerMetadataOwners,
        "resolveProviderRequestPolicy",
      ),
    },
    env,
  );
}

/** @deprecated Await prepareModelProviderRequestRouteFacts; removed in the next Plugin SDK major. */
export function resolveProviderRequestCapabilitiesLegacy(
  ...[input, env]: Parameters<typeof resolveCapabilities>
) {
  return resolveCapabilities(
    {
      ...input,
      providerMetadataOwners: prepareLegacyOwners(
        input.providerMetadataOwners,
        "resolveProviderRequestCapabilities",
      ),
    },
    env,
  );
}
