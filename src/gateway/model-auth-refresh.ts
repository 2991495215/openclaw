import { reloadSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { prepareModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../secrets/runtime.js";
import { resolveModelAuthAgentScope } from "./server-methods/model-auth-agent-scope.js";
import { clearModelAuthStatusUsageCache } from "./server-methods/models-auth-status-usage-cache.js";

export async function refreshModelAuthStateAfterMutation(
  getRuntimeConfig: () => OpenClawConfig,
  agentId: string,
): Promise<void> {
  // The first CLI login can move the shared store after this Gateway pinned its owner.
  console.log("CATALOG_REFRESH_TRACE", "ownership-reload-start");
  await reloadSharedAuthStoreOwnership();
  console.log("CATALOG_REFRESH_TRACE", "ownership-reload-end");
  clearModelAuthStatusUsageCache();
  console.log("CATALOG_REFRESH_TRACE", "secrets-refresh-start");
  await refreshActiveProviderAuthRuntimeSnapshot();
  console.log("CATALOG_REFRESH_TRACE", "secrets-refresh-end");
  const config = getRuntimeConfig();
  const scope = resolveModelAuthAgentScope(config, agentId);
  if (!scope.ok) {
    throw new Error(scope.error.message);
  }
  // Persistence and secrets activation publish actual auth changes; join that generation.
  console.log("CATALOG_REFRESH_TRACE", "runtime-prepare-start");
  await prepareModelRuntimeSnapshot({ config, agentId, agentDir: scope.agentDir });
  console.log("CATALOG_REFRESH_TRACE", "runtime-prepare-end");
}
