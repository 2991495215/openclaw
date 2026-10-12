import type { PluginCompatRecord } from "./types.js";

const DISCOVERY_MIGRATION = {
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-01",
  deprecated: "2026-10-12",
  warningStarts: "2026-10-12",
  removalGate: "next-plugin-sdk-major",
} as const;

export const PROVIDER_DISCOVERY_COMPAT_RECORDS = [
  {
    ...DISCOVERY_MIGRATION,
    code: "provider-catalog-sync-discovery",
    replacement:
      "Await resolvePluginProvidersAsync. The synchronous resolvePluginProviders export remains available for an already prepared and loaded provider registry; it does not perform cold native discovery.",
    docsPath: "/plugins/sdk-migration#provider-discovery",
    surfaces: ["openclaw/plugin-sdk/provider-catalog-runtime resolvePluginProviders"],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous provider selection"],
    tests: ["src/plugin-sdk/provider-catalog-runtime.test.ts"],
  },
  {
    ...DISCOVERY_MIGRATION,
    code: "speech-registry-sync",
    replacement:
      "Await getSpeechProviderAsync, listSpeechProvidersAsync, canonicalizeSpeechProviderIdAsync, getResolvedSpeechProviderConfigAsync, resolveTtsProviderOrderAsync, and setTtsProviderAsync. Synchronous counterparts require an already prepared provider registry or an explicit prepared inventory; they do not perform cold native discovery.",
    docsPath: "/plugins/sdk-migration#speech-provider-discovery",
    surfaces: [
      "openclaw/plugin-sdk/speech getSpeechProvider",
      "openclaw/plugin-sdk/speech-core getSpeechProvider",
      "openclaw/plugin-sdk/speech-core listSpeechProviders",
      "openclaw/plugin-sdk/speech-core canonicalizeSpeechProviderId",
      "openclaw/plugin-sdk/tts-runtime getResolvedSpeechProviderConfig",
      "openclaw/plugin-sdk/tts-runtime resolveTtsProviderOrder",
      "openclaw/plugin-sdk/tts-runtime setTtsProvider",
    ],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warnings for synchronous speech registry operations"],
    tests: ["src/tts/provider-registry.test.ts", "src/gateway/server-methods/tts.test.ts"],
  },
  {
    ...DISCOVERY_MIGRATION,
    code: "embedding-registry-sync",
    replacement:
      "Await getEmbeddingProviderAsync, listEmbeddingProvidersAsync, getMemoryEmbeddingProviderAsync, listMemoryEmbeddingProvidersAsync, and resolveMemorySearchConfigAsync on their existing subpaths. Synchronous counterparts require prepared provider facts and do not perform cold native discovery.",
    docsPath: "/plugins/sdk-migration/removed-surfaces#migration-reference",
    surfaces: [
      "openclaw/plugin-sdk/embedding-providers getEmbeddingProvider",
      "openclaw/plugin-sdk/embedding-providers listEmbeddingProviders",
      "openclaw/plugin-sdk/memory-core-host-engine-embeddings getMemoryEmbeddingProvider",
      "openclaw/plugin-sdk/memory-core-host-embedding-registry listMemoryEmbeddingProviders",
      "openclaw/plugin-sdk/memory-core-host-engine-foundation resolveMemorySearchConfig",
      "openclaw/plugin-sdk/memory-core-host-runtime-core resolveMemorySearchConfig",
    ],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warnings for synchronous embedding discovery"],
    tests: ["src/plugins/embedding-provider-runtime.test.ts", "src/agents/memory-search.test.ts"],
  },
] as const satisfies readonly PluginCompatRecord[];
