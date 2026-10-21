import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../plugins/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const { resolveRuntimePluginDiscoveryProviders } = vi.hoisted(() => ({
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
}));
vi.mock("../plugins/provider-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-discovery.js")>()),
  resolveRuntimePluginDiscoveryProviders,
}));

import {
  configForProviders,
  modelDefinition,
  providerEntry,
} from "./model-auth.fixtures.test-support.js";
import { planOpenClawModelsJsonSource } from "./models-config.js";
import {
  prepareImplicitProviderStaticCatalog,
  resolveImplicitProviders,
} from "./models-config.providers.implicit.js";
import {
  filterGeneratedPluginModelCatalogProviders,
  replacePersistedPluginModelCatalogs,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "./plugin-model-catalog.js";

const nativeModel = modelDefinition("native-model", {
  name: "Native model",
  contextWindow: 128000,
});
const nativeCatalog = providerEntry("https://native.example/v1", {
  api: "openai-completions",
  models: [nativeModel],
});
const provider: ProviderPlugin = {
  id: "fixture",
  pluginId: "catalog-owner",
  label: "Fixture",
  auth: [],
  staticCatalog: { order: "simple", run: async () => ({ provider: nativeCatalog }) },
};
function createMetadata(providers = ["fixture"], configuredEndpointDiscovery = false) {
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "catalog-owner",
        providers,
        providerEndpoints: [{ endpointClass: "openai-public", hosts: ["native.example"] }],
        ...(configuredEndpointDiscovery
          ? {
              modelCatalog: {
                discovery: { fixture: "runtime" as const },
                configuredEndpointDiscovery: ["fixture"],
                providers: { fixture: nativeCatalog },
              },
            }
          : {}),
      },
    ],
  });
}

let state: OpenClawTestState;
const customProvider = providerEntry("https://proxy.example/v1");
function discoveryParams(providers = ["fixture"], ids = providers) {
  return {
    env: state.env,
    agentDir: state.agentDir(),
    pluginMetadataSnapshot: createMetadata(providers),
    providerDiscoveryProviderIds: ids,
    providerDiscoveryEntriesOnly: true,
  };
}
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "endpoint-eligibility" });
  resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
});
afterEach(async () => {
  await state.cleanup();
  vi.clearAllMocks();
});

it("does not recover a generated native endpoint over an authored custom provider", async () => {
  await replacePersistedPluginModelCatalogs({
    agentDir: state.agentDir(),
    pluginCatalogWrites: {
      "plugins/catalog-owner/catalog.json": JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: { fixture: nativeCatalog },
      }),
    },
  });
  const authored = { id: "manual-model", name: "Authored model", contextWindow: 16384 };
  const explicit = {
    ...nativeCatalog,
    baseUrl: "https://proxy.example/v1",
    models: [{ ...nativeModel, ...authored }],
  };
  const planned = await planOpenClawModelsJsonSource(
    configForProviders({ fixture: explicit }),
    state.agentDir(),
    discoveryParams(),
  );
  const catalog = planned.pluginCatalogs.find((entry) => entry.pluginId === "catalog-owner");
  assert(catalog, "The source plan must contain the authored provider");
  expect(JSON.parse(catalog.contents).providers.fixture).toMatchObject({
    baseUrl: "https://proxy.example/v1",
    models: [authored],
  });
});
it("preserves a selected native alias when its sibling has a custom endpoint", async () => {
  const aliasedProvider = { ...provider, aliases: ["alternate"] };
  resolveRuntimePluginDiscoveryProviders.mockResolvedValue([aliasedProvider]);
  const params = {
    config: configForProviders({
      fixture: customProvider,
      alternate: providerEntry(nativeCatalog.baseUrl),
    }),
    ...discoveryParams(["fixture", "alternate"], ["alternate"]),
  };
  const preparedStaticProviderCatalog = await prepareImplicitProviderStaticCatalog(params);
  const providerConfigs = { alternate: nativeCatalog };
  expect(preparedStaticProviderCatalog.entries).toEqual([
    { provider: aliasedProvider, providerConfigs },
  ]);
  const discovered = await resolveImplicitProviders({
    ...params,
    preparedStaticProviderCatalog,
    explicitProviders: {
      alternate: { ...nativeCatalog, models: [{ ...nativeModel, name: "Authored model" }] },
    },
  });
  expect(discovered?.alternate?.models.map((model) => model.id)).toEqual(["native-model"]);
  expect(discovered?.alternate?.models[0]?.name).toBe("Authored model");
  expect(discovered?.fixture).toBeUndefined();
  const next = await resolveImplicitProviders({ ...params, preparedStaticProviderCatalog });
  expect(next?.alternate).toMatchObject({
    baseUrl: "https://native.example/v1",
    models: [{ name: "Native model" }],
  });
  expect(preparedStaticProviderCatalog.entries[0]?.providerConfigs.alternate?.models[0]?.name).toBe(
    "Native model",
  );
  expect(nativeCatalog.models[0]?.name).toBe("Native model");
});
it("keeps auth handles but records excluded prepared catalogs as empty", async () => {
  const run = vi.fn(async () => ({ provider: nativeCatalog }));
  const excludedProvider: ProviderPlugin = { ...provider, staticCatalog: { run } };
  resolveRuntimePluginDiscoveryProviders.mockResolvedValue([excludedProvider]);
  const prepared = await prepareImplicitProviderStaticCatalog({
    ...discoveryParams(),
    config: configForProviders({ fixture: customProvider }),
  });
  expect(prepared.providers).toEqual([excludedProvider]);
  expect(prepared.entries).toEqual([{ provider: excludedProvider, providerConfigs: {} }]);
  expect(run).not.toHaveBeenCalled();
});

it("preserves an eligible shared-hook output without aliases", async () => {
  const sharedProvider: ProviderPlugin = {
    ...provider,
    staticCatalog: {
      order: "simple",
      run: async () => ({ providers: { fixture: nativeCatalog, alternate: nativeCatalog } }),
    },
  };
  resolveRuntimePluginDiscoveryProviders.mockResolvedValue([sharedProvider]);
  const params = {
    ...discoveryParams(["fixture", "alternate"]),
    providerDiscoveryProviderIds: undefined,
    config: configForProviders({ fixture: customProvider }),
  };
  const preparedStaticProviderCatalog = await prepareImplicitProviderStaticCatalog(params);
  const discovered = await resolveImplicitProviders({
    ...params,
    preparedStaticProviderCatalog,
  });
  expect(discovered?.alternate?.models.map((model) => model.id)).toEqual(["native-model"]);
  expect(discovered?.fixture).toBeUndefined();
});

it.each([
  { optedIn: true, liveRows: true },
  { optedIn: true, liveRows: false },
  { optedIn: false, liveRows: true },
])(
  "discovers configured endpoints only through opted-in live hooks: %j",
  async ({ optedIn, liveRows }) => {
    const liveCatalog = {
      ...customProvider,
      models: [modelDefinition("deployment-model")],
    };
    const liveRun = vi.fn(async () => (liveRows ? { provider: liveCatalog } : null));
    const staticRun = vi.fn(async () => ({ provider: nativeCatalog }));
    resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      { ...provider, catalog: { run: liveRun }, staticCatalog: { run: staticRun } },
    ]);
    const discovered = await resolveImplicitProviders({
      ...discoveryParams(),
      providerDiscoveryEntriesOnly: false,
      config: configForProviders({ fixture: customProvider }),
      pluginMetadataSnapshot: createMetadata(["fixture"], optedIn),
    });
    expect(liveRun).toHaveBeenCalledTimes(optedIn ? 1 : 0);
    expect(staticRun).not.toHaveBeenCalled();
    expect(discovered?.fixture?.models.map((model) => model.id) ?? []).toEqual(
      optedIn && liveRows ? ["deployment-model"] : [],
    );
  },
);

it.each([
  { baseUrl: "https://proxy.example/v1/", keep: true },
  { baseUrl: "https://old-proxy.example/v1", keep: false },
  { baseUrl: "https://native.example/v1", keep: false },
  { baseUrl: undefined, keep: false },
  {
    baseUrl: "https://proxy.example/v1/transport",
    sourceBaseUrl: "https://proxy.example/v1",
    keep: true,
  },
  { baseUrl: "https://proxy.example/v1", sourceBaseUrl: "https://old-proxy.example", keep: false },
])(
  "keeps configured-endpoint cache only for its acquisition URL: %j",
  ({ baseUrl, sourceBaseUrl, keep }) => {
    const providers = { fixture: { ...nativeCatalog, baseUrl } };
    expect(
      filterGeneratedPluginModelCatalogProviders({
        catalogPluginId: "catalog-owner",
        config: configForProviders({ fixture: customProvider }),
        pluginMetadataSnapshot: createMetadata(["fixture"], true),
        providers,
        parsedCatalog: {
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          ...(sourceBaseUrl ? { sourceBaseUrls: { fixture: sourceBaseUrl } } : {}),
        },
      }),
    ).toEqual(keep ? providers : {});
  },
);
