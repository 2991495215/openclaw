import type { PluginWebFetchProviderEntry } from "./types.js";
import {
  resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebFetchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.js";
import {
  mapRegistryProviders,
  resolveBundledWebProviderResolutionConfig,
  resolveManifestDeclaredWebProviderCandidatePluginIds,
} from "./web-provider-resolution-shared.js";
import {
  resolvePluginWebProviders,
  resolvePluginWebProvidersAsync,
  type ResolvePluginWebProvidersParams,
  type ResolveRuntimeWebProvidersParams,
  type WebProviderRuntimeResolution,
} from "./web-provider-runtime-shared.js";

const providerResolution = {
  resolveBundledResolutionConfig: (params) =>
    resolveBundledWebProviderResolutionConfig({ ...params, contract: "webFetchProviders" }),
  resolveCandidatePluginIds: (params) =>
    resolveManifestDeclaredWebProviderCandidatePluginIds({
      ...params,
      contract: "webFetchProviders",
      configKey: "webFetch",
    }),
  mapRegistryProviders: ({ registry, onlyPluginIds }) =>
    mapRegistryProviders({ registry, entries: registry.webFetchProviders, onlyPluginIds }),
} satisfies WebProviderRuntimeResolution<PluginWebFetchProviderEntry>;

/** Resolves web fetch providers from bundled artifacts or scoped plugin loads. */
/** @deprecated Use resolvePluginWebFetchProvidersAsync for cold discovery. */
export function resolvePluginWebFetchProviders(
  params: ResolvePluginWebProvidersParams,
): PluginWebFetchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    ...providerResolution,
    resolveBundledPublicArtifactProviders: resolveBundledWebFetchProvidersFromPublicArtifacts,
    resolveBundledRuntimeArtifactProviders:
      resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  });
}

/** Resolves already-eligible runtime web fetch providers without setup-mode activation. */
/** @deprecated Use resolveRuntimeWebFetchProvidersAsync for cold discovery. */
export function resolveRuntimeWebFetchProviders(
  params: ResolveRuntimeWebProvidersParams,
): PluginWebFetchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    ...providerResolution,
    resolveBundledRuntimeArtifactProviders:
      resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  });
}

/** Resolves plugin web fetch providers after preparing worker-owned metadata. */
export function resolvePluginWebFetchProvidersAsync(
  params: ResolvePluginWebProvidersParams,
): Promise<PluginWebFetchProviderEntry[]> {
  return resolvePluginWebProvidersAsync(params, {
    ...providerResolution,
    resolveBundledPublicArtifactProviders: resolveBundledWebFetchProvidersFromPublicArtifacts,
    resolveBundledRuntimeArtifactProviders:
      resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  });
}

/** Resolves eligible runtime providers through the async registry owner. */
export function resolveRuntimeWebFetchProvidersAsync(
  params: ResolveRuntimeWebProvidersParams,
): Promise<PluginWebFetchProviderEntry[]> {
  return resolvePluginWebProvidersAsync(params, {
    ...providerResolution,
    resolveBundledRuntimeArtifactProviders:
      resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  });
}
