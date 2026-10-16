import { loadDotEnv } from "../infra/dotenv.js";
import {
  createConfigRuntimeEnvBase,
  getPublishedConfigRuntimeEnvState,
} from "./config-env-vars.js";
import { GATEWAY_CONFIG_SELECTION_ENV_KEYS } from "./gateway-env-selection.js";
import { getRuntimeConfigSourceSnapshot } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";

export function maybeLoadDotEnvForConfig(env: NodeJS.ProcessEnv): void {
  // Injected env objects are test/diagnostic sandboxes and must stay isolated.
  if (env === process.env) {
    loadDotEnv({ quiet: true });
  }
}

export function resolveManagedRuntimeEnvBaseline(): {
  sourceConfig: OpenClawConfig;
} {
  const published = getPublishedConfigRuntimeEnvState();
  return {
    sourceConfig: published.sourceConfig ?? getRuntimeConfigSourceSnapshot() ?? {},
  };
}

export function createManagedRuntimeEnvBase(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return createConfigRuntimeEnvBase(resolveManagedRuntimeEnvBaseline().sourceConfig, env, {
    // Copied caller environments still carry the published layer's recorded ownership.
    ownedEnv: getPublishedConfigRuntimeEnvState().ownedEnv,
    preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
  });
}
