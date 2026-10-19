import { createStaticProviderCatalog } from "openclaw/plugin-sdk/provider-model-metadata";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildStaticDeepInfraProvider } from "./provider-static-catalog.js";

const PROVIDER_ID = "deepinfra";

const deepinfraProviderDiscovery: ProviderPlugin = {
  id: PROVIDER_ID,
  label: "DeepInfra",
  docsPath: "/providers/deepinfra",
  auth: [],
  catalog: {
    order: "simple",
    // Static inventory stays independent of credential and network discovery.
    run: async (ctx) => {
      const { buildDeepInfraApiKeyCatalog } = await import("./provider-catalog.js");
      return await buildDeepInfraApiKeyCatalog(ctx);
    },
  },
  staticCatalog: createStaticProviderCatalog(buildStaticDeepInfraProvider),
};

export default deepinfraProviderDiscovery;
