import { createStaticProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildMoonshotProvider } from "./provider-catalog.js";

const moonshotProviderDiscovery: ProviderPlugin = {
  id: "moonshot",
  label: "Moonshot",
  docsPath: "/providers/moonshot",
  aliases: ["moonshotai", "moonshot-ai"],
  auth: [],
  staticCatalog: createStaticProviderCatalog(buildMoonshotProvider),
};

export default moonshotProviderDiscovery;
