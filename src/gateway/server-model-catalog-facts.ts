import { getPreparedRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/store.js";
import { getPreparedModelFullCatalogAuth } from "../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";

/** Keeps full catalog rows paired with their auth; static rows use current published auth facts. */
export function capturePreparedModelCatalogFacts(owner: PreparedModelRuntimeSnapshot) {
  const fullModelCatalog = owner.readFullModelCatalog?.();
  const fullCatalogAuth = fullModelCatalog
    ? getPreparedModelFullCatalogAuth(fullModelCatalog)
    : undefined;
  if (fullModelCatalog && !fullCatalogAuth) {
    throw new Error("prepared full model catalog omitted its auth generation");
  }
  return {
    modelCatalog: fullModelCatalog ?? owner.modelCatalog,
    authModes: fullCatalogAuth?.authModes ?? owner.authModes,
    authStore: fullCatalogAuth?.authStore ??
      getPreparedRuntimeAuthProfileStoreSnapshot(owner.agentDir, owner.inheritedAuthDir) ?? {
        version: 1 as const,
        profiles: {},
      },
  };
}
