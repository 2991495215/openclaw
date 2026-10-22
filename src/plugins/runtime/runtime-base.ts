import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { getRuntimeConfig } from "../../config/io.runtime.js";
import { resolveStateDir } from "../../config/paths.js";
import { cloneConfigWithResolutionFacts } from "../../config/resolution-facts.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createLazyRuntimeMethod, createLazyRuntimeSurface } from "../../shared/lazy-runtime.js";
import { formatNativeDependencyHint } from "./native-deps.js";
import { captureSessionEventTarget, enqueueSessionEvent } from "./runtime-session-events.js";
import { enqueueSystemEventFromSdk } from "./system-events.js";
import type { PluginRuntimeBase, PluginRuntime } from "./types.js";

export const COMMAND_NATIVE_SUBAGENTS_CAPABILITY = "command-native-subagents-v1";
const NATIVE_SUBAGENT_LIST_CAPABILITY = "native-subagent-list-v1";
/** Probe before registering a command that requests `runtimeCapabilities: ["scheduledTurns"]`. */
export const COMMAND_SCHEDULED_TURNS_CAPABILITY = "command-scheduled-turns-v1";

function unavailable(method: string): () => never {
  return () => {
    throw new Error(`${method} is only available through the plugin runtime proxy.`);
  };
}

/** Host-owned facades survive later path-loaded runtime materialization unchanged. */
export function createRuntimeBase(): PluginRuntimeBase {
  const loadAcquireLocalService = createLazyRuntimeMethod(
    () => import("../../agents/provider-local-service.js"),
    (runtime) => runtime.createConfiguredProviderLocalServiceAcquirer(getRuntimeConfig),
  );
  const loadLlm = createLazyRuntimeSurface(
    () => import("./runtime-llm.runtime.js"),
    (m) =>
      m.createRuntimeLlm({
        getConfig: getRuntimeConfig,
        authority: {
          allowComplete: true,
        },
      }),
  );
  let system: PluginRuntime["system"] | undefined;
  return {
    capabilities: Object.freeze([
      GATEWAY_SERVER_CAPS.SENDER_RESTRICTED_HIDDEN_HELPERS,
      COMMAND_NATIVE_SUBAGENTS_CAPABILITY,
      "requester-model-catalog-v1",
      NATIVE_SUBAGENT_LIST_CAPABILITY,
      COMMAND_SCHEDULED_TURNS_CAPABILITY,
    ]),
    config: {
      current: (options?: { clone: true }) => {
        const config = getRuntimeConfig();
        return options?.clone ? cloneConfigWithResolutionFacts(config) : config;
      },
      mutateConfigFile: async (params) => {
        const { mutateConfigFile } = await import("../../config/mutate.js");
        return await mutateConfigFile(params);
      },
      replaceConfigFile: async (params) => {
        const { replaceConfigFile } = await import("../../config/mutate.js");
        return await replaceConfigFile(params);
      },
    },
    llm: {
      acquireLocalService: loadAcquireLocalService,
      complete: createLazyRuntimeMethod(loadLlm, (llm) => llm.complete),
    },
    // Only the registry proxy grants storage, never the base runtime directly.
    state: {
      resolveStateDir,
      openBlobStore: unavailable("openBlobStore"),
      openKeyedStore: unavailable("openKeyedStore"),
      openKeyedStoreV2: unavailable("openKeyedStoreV2"),
      openSyncKeyedStore: unavailable("openSyncKeyedStore"),
      openChannelIngressQueue: unavailable("openChannelIngressQueue"),
      openChannelIngressDrain: unavailable("openChannelIngressDrain"),
    },
    get system() {
      return (system ??= {
        captureSessionEventTarget,
        enqueueSessionEvent,
        enqueueSystemEvent: enqueueSystemEventFromSdk,
        runCommandWithTimeout,
        formatNativeDependencyHint,
      });
    },
  };
}
