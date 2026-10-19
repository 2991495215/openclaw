import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyHuggingfaceConnectionConfig, HUGGINGFACE_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildHuggingfaceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "huggingface";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Hugging Face Provider",
  description: "Bundled Hugging Face provider plugin",
  manifest,
  provider: {
    label: "Hugging Face",
    docsPath: "/providers/huggingface",
    envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
    manifestAuth: {
      defaultModel: HUGGINGFACE_DEFAULT_MODEL_REF,
      applyConfig: applyHuggingfaceConnectionConfig,
    },
    catalog: {
      run: async (ctx) => {
        const pluginConfig = resolvePluginConfigObject(ctx.config, PROVIDER_ID);
        if (asOptionalObjectRecord(pluginConfig?.discovery)?.enabled === false) {
          return null;
        }
        const { apiKey, discoveryApiKey, profileId } = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        const run = async () => ({
          provider: {
            ...(await buildHuggingfaceProvider(discoveryApiKey, { discoveryMode: "strict" })),
            apiKey,
          },
        });
        return discoveryApiKey
          ? await runLiveProviderCatalog({ providerId: PROVIDER_ID, profileId, run })
          : await run();
      },
      // Startup and unauthenticated catalog reads must not depend on live discovery.
      staticRun: async () => ({ provider: await buildHuggingfaceProvider() }),
    },
  },
});
