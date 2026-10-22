import { onSettled } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";

/** Raw commands retire their presentation without cancelling the owner's operation. */
export function createConfigCommandPresentation(
  context: ApplicationContext,
  updateBusy: () => boolean,
) {
  let lifetime = Promise.withResolvers<void>();
  function retire() {
    lifetime.resolve();
    lifetime = Promise.withResolvers<void>();
  }
  onSettled(() => {
    let location = context.router.getState().location;
    const stop = context.router.subscribe(() => {
      const next = context.router.getState().location;
      if (
        next.pathname !== location.pathname ||
        next.search !== location.search ||
        next.hash !== location.hash
      ) {
        location = next;
        retire();
      }
    });
    return () => {
      stop();
      lifetime.resolve();
    };
  });
  return {
    retire,
    retired: () => lifetime.promise,
    mutationDisabled() {
      const state = context.runtimeConfig.state;
      return (
        !state.connected ||
        state.configLoading ||
        state.configSaving ||
        state.configApplying ||
        updateBusy() ||
        context.overlays.snapshot.updateStatusRefreshing ||
        !context.runtimeConfig.canSet ||
        !hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null)
      );
    },
  };
}
