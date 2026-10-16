import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import { PluginAdmittedWorkTimeoutError } from "./server-plugin-reload-cleanup.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

export function isConfigReloadSuperseded(error: unknown): boolean {
  // Only completed rollback preserves the direct cause. Cleanup failures and
  // published replacements must settle instead of transferring the write.
  const cause =
    error instanceof PluginRuntimeApplicationError && !error.details.committed
      ? error.cause
      : error;
  return cause instanceof GatewayConfigReloadSupersededError;
}

/** Retry a timed-out automatic drain once its exact plugin instances become idle. */
export function createConfigPluginDrainTracker(params: {
  signal: AbortSignal;
  onWorkSettled: () => void;
}) {
  let observation: AbortController | undefined;
  const cancel = () => {
    observation?.abort();
    observation = undefined;
  };
  return {
    cancel,
    recordFailure(plan: GatewayReloadPlan, error: unknown) {
      if (
        !plan.pluginLifecycle &&
        error instanceof PluginRuntimeApplicationError &&
        error.details.phase === "drain" &&
        !error.details.committed &&
        error.cause instanceof PluginAdmittedWorkTimeoutError
      ) {
        cancel();
        observation = new AbortController();
        const signal = AbortSignal.any([params.signal, observation.signal]);
        // The rolled-back generation keeps accepting work. Observe its calls and
        // cleanup too, so idle settlement can retry without another config edit.
        void Promise.all(
          error.cause.instances.map((instance) => instance.waitForIdle(signal)),
        ).then(
          () => {
            if (!signal.aborted) {
              cancel();
              params.onWorkSettled();
            }
          },
          () => {},
        );
      }
    },
  };
}
