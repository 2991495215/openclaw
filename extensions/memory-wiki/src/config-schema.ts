// Keep exported JSON Schema construction outside Doctor's config-resolution closure.
import { createPluginConfigSafeParse } from "openclaw/plugin-sdk/extension-shared";
import { buildPluginConfigSchema } from "../api.js";
import { MemoryWikiConfigSource, resolveMemoryWikiConfig } from "./config.js";

export const memoryWikiConfigSchema = buildPluginConfigSchema(MemoryWikiConfigSource, {
  safeParse: createPluginConfigSafeParse(
    MemoryWikiConfigSource.optional().transform((config) => resolveMemoryWikiConfig(config)),
  ),
});
