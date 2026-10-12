import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { loadGetReplyFromConfigRuntime } from "../auto-reply/reply/dispatch-from-config.runtime-loaders.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type InternalHookSelection, resolveInternalHookSelection } from "../hooks/configured.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-state-context.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { hasRestartSentinel } from "../infra/restart-sentinel.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginServiceCronHost } from "../plugins/service-cron.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { GatewayPluginRuntimeClaim } from "./server-plugin-runtime-generation.js";
import { isChannelStartupSuppressedByEnvironment } from "./server-sidecar-startup-mode.js";
import {
  hydrateConfiguredExternalCliAuth,
  publishConfiguredModelRuntimeSnapshots,
} from "./server-startup-model-runtime.js";
import type { GatewayStartupOutcomeRecorder } from "./server-startup-outcomes.js";
import { scheduleRestartSentinelWakeAfterReady } from "./server-startup-restart-sentinel.js";
import {
  scheduleGatewayGenerationTimer,
  schedulePostReadySidecarTask,
  type GatewayPostReadySidecarHandle,
} from "./server-startup-sidecar-scheduler.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

const ACP_BACKEND_READY_TIMEOUT_MS = 5_000;
const ACP_BACKEND_READY_POLL_MS = 50;
type Awaitable<T> = T | Promise<T>;

const loadAgentDefaultsModule = createLazyRuntimeModule(() => import("../agents/defaults.js"));

const loadAgentModelSelectionModule = createLazyRuntimeModule(
  () => import("../agents/model-selection.js"),
);

const loadInternalHooksModule = createLazyRuntimeModule(() => import("../hooks/internal-hooks.js"));

async function hasGatewayStartupInternalHookListeners(): Promise<boolean> {
  const { hasInternalHookListeners } = await loadInternalHooksModule();
  return hasInternalHookListeners("gateway", "startup");
}

async function waitForAcpRuntimeBackendReady(backendId?: string): Promise<boolean> {
  const { getAcpRuntimeBackend } = await import("../acp/runtime/registry.js");
  const deadline = performance.now() + ACP_BACKEND_READY_TIMEOUT_MS;

  do {
    const backend = getAcpRuntimeBackend(backendId);
    if (backend) {
      try {
        if (!backend.healthy || backend.healthy()) {
          return true;
        }
      } catch {
        // Treat transient backend health probe errors like "not ready yet".
      }
    }
    await sleep(ACP_BACKEND_READY_POLL_MS, undefined, { ref: false });
  } while (performance.now() < deadline);

  return false;
}

/** Start post-ready sidecars such as channels, hooks, plugin services, and cleanup tasks. */
export async function startGatewaySidecars(params: {
  scheduler: GatewayScheduler;
  restartSentinelContext?: DeliveryQueueStateContext;
  cfg: OpenClawConfig;
  getModelRuntimeConfig?: () => OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  pluginRegistry: PluginRegistry;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  getCronService?: () => PluginServiceCronHost | null | undefined;
  shouldStartChannels?: () => boolean;
  refreshChatMetadata?: () => Promise<void>;
  onChannelsStarted?: () => Awaitable<void>;
  onPluginServices?: (pluginServices: PluginServicesHandle | null) => void;
  onPostReadySidecars: (...sidecars: GatewayPostReadySidecarHandle[]) => void;
  shouldCreatePostReadySidecars?: () => boolean;
  shouldStartPluginServices?: (pendingOwner?: PluginServicesHandle) => boolean;
  pluginRuntimeClaim?: GatewayPluginRuntimeClaim;
  broadcastPluginEvent?: import("./server-broadcast-types.js").GatewayPluginEventBroadcastFn;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  startupTrace?: GatewayStartupTrace;
  startupOutcomes?: GatewayStartupOutcomeRecorder;
  internalHookSelection?: InternalHookSelection;
  waitForPostReadyWork?: () => Promise<void>;
}) {
  const restartSentinelContext =
    params.restartSentinelContext ?? captureDeliveryQueueStateContext();
  const postReadySidecars: GatewayPostReadySidecarHandle[] = [];
  const scheduleSidecar = (
    task: Pick<Parameters<typeof schedulePostReadySidecarTask>[0], "name" | "run" | "stop">,
  ) => {
    postReadySidecars.push(
      schedulePostReadySidecarTask({
        startupTrace: params.startupTrace,
        log: params.log,
        waitForPostReadyWork: params.waitForPostReadyWork,
        shouldRun: params.shouldCreatePostReadySidecars,
        ...task,
      }),
    );
  };

  const internalHookSelection =
    params.internalHookSelection ?? (await resolveInternalHookSelection(params.cfg));
  const internalHooksConfigured = internalHookSelection.configured;
  await measureStartup(params.startupTrace, "sidecars.internal-hooks", async () => {
    try {
      const { prepareInternalHooks } = await import("../hooks/loader.js");
      const prepared = await prepareInternalHooks(params.cfg, params.defaultWorkspaceDir, {
        failureMode: "best-effort",
        selection: internalHookSelection,
      });
      if (
        params.shouldCreatePostReadySidecars?.() === false ||
        !prepared.commit({ initial: true })
      ) {
        params.startupOutcomes?.record({
          subsystem: "internal-hooks",
          status: "skipped",
          reason: "superseded",
        });
        return;
      }
      if (!internalHooksConfigured) {
        return;
      }
      const { loadedCount } = prepared;
      if (loadedCount > 0) {
        params.startupOutcomes?.record({ subsystem: "internal-hooks", status: "loaded" });
        params.logHooks.info(
          `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
        );
      } else {
        params.startupOutcomes?.record({
          subsystem: "internal-hooks",
          status: "skipped",
          reason: "no-handlers-loaded",
        });
      }
    } catch (err) {
      params.startupOutcomes?.record({
        subsystem: "internal-hooks",
        status: "failed",
        reason: "see earlier log",
      });
      params.logHooks.error(`failed to load hooks: ${String(err)}`);
    }
  });

  const skipChannels = isChannelStartupSuppressedByEnvironment();
  const getModelRuntimeConfig = params.getModelRuntimeConfig ?? (() => params.cfg);
  // Agent RPC remains available when transports are disabled. Publish configured/static facts before
  // accepting work; live provider catalogs stay advisory and never enter the Gateway lifecycle.
  if ((await params.pluginRuntimeClaim?.waitForUnblocked()) !== false) {
    await measureStartup(params.startupTrace, "sidecars.model-runtime", () =>
      withPluginRuntimeRegistryScope(params.pluginRegistry, () =>
        publishConfiguredModelRuntimeSnapshots({
          cfg: params.cfg,
          getConfig: () =>
            measureStartup(params.startupTrace, "sidecars.model-auth", () =>
              hydrateConfiguredExternalCliAuth({
                getConfig: getModelRuntimeConfig,
                log: params.log,
              }),
            ),
          isCurrent: params.pluginRuntimeClaim?.isCurrent,
          ...(params.pluginMetadataSnapshot
            ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
            : {}),
          workspaceDir: params.defaultWorkspaceDir,
          startupTrace: params.startupTrace,
        }),
      ),
    );
  }
  // Gateway readiness owns process-stable reply module activation so the first operator turn
  // does not become the module loader under contention.
  await measureStartup(params.startupTrace, "sidecars.reply-runtime", async () => {
    const { prewarmConfigDrivenReplyRuntime } = await loadGetReplyFromConfigRuntime();
    await prewarmConfigDrivenReplyRuntime();
  });
  await measureStartup(params.startupTrace, "sidecars.chat-metadata", async () => {
    await params.refreshChatMetadata?.();
  });
  const shouldStartChannels = params.shouldStartChannels?.() !== false;
  await measureStartup(params.startupTrace, "sidecars.channels", async () => {
    const channelStart = skipChannels
      ? measureStartup(params.startupTrace, "sidecars.channel-skip", () =>
          params.logChannels.info(
            "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
          ),
        )
      : shouldStartChannels
        ? measureStartup(params.startupTrace, "sidecars.channel-start", params.startChannels).catch(
            (err: unknown) => params.logChannels.error(`channel startup failed: ${String(err)}`),
          )
        : Promise.resolve();
    // Account tasks can depend on this generation gate, so release it after
    // their handoff is prepared but before waiting for that handoff to settle.
    const accountStartGateRelease = shouldStartChannels ? params.onChannelsStarted?.() : undefined;
    await Promise.all([accountStartGateRelease, channelStart]);
  });

  await params.pluginRuntimeClaim?.waitForUnblocked();
  const shouldStartPluginServices =
    params.pluginRuntimeClaim?.isCurrent() !== false &&
    params.shouldStartPluginServices?.() !== false;
  if (shouldStartPluginServices) {
    let pluginServicesStopRequested = false;
    const ownedPluginServices = createDeferredCore<PluginServicesHandle | null>();
    const pluginServicesOwner: PluginServicesHandle = {
      reload: async (config, serviceIds) => {
        const handle = await ownedPluginServices.promise;
        if (pluginServicesStopRequested || !handle) {
          throw new Error("Plugin services are stopping");
        }
        await handle.reload(config, serviceIds);
      },
      stop: (options) => {
        pluginServicesStopRequested = true;
        // Pending startup owns no services and may be waiting on this replacement.
        ownedPluginServices.resolve(null);
        // Share the service owner, never a caller's expired replacement deadline.
        const stopPromise = ownedPluginServices.promise.then((handle) => handle?.stop(options));
        const deadlineAtMs = options?.strict ? options.deadlineAtMs : undefined;
        if (deadlineAtMs === undefined) {
          return stopPromise;
        }
        return raceWithTimeout(
          stopPromise.catch((error: unknown) => {
            throw error instanceof Error ? error : new Error(String(error));
          }),
          Math.max(0, deadlineAtMs - Date.now()),
          () => {
            throw new AggregateError(
              [new Error("Gateway plugin service startup did not settle before replacement")],
              "Gateway plugin service replacement cleanup failed",
            );
          },
        );
      },
    };
    // Startup may outlive a replacement deadline. Final shutdown retains this
    // owner without making startup rejoin its pending service cleanup.
    params.onPluginServices?.(pluginServicesOwner);
    await measureStartup(params.startupTrace, "sidecars.plugin-services", async () => {
      try {
        const { startPluginServices } = await import("../plugins/services.js");
        await params.pluginRuntimeClaim?.waitForUnblocked();
        if (
          pluginServicesStopRequested ||
          params.pluginRuntimeClaim?.isCurrent() === false ||
          params.shouldStartPluginServices?.(pluginServicesOwner) === false
        ) {
          ownedPluginServices.resolve(null);
          return;
        }
        await startPluginServices({
          scheduler: params.scheduler,
          registry: params.pluginRegistry,
          config: params.cfg,
          workspaceDir: params.defaultWorkspaceDir,
          startupTrace: params.startupTrace,
          broadcastPluginEvent: params.broadcastPluginEvent,
          getCronService: params.getCronService,
          onHandle: (handle) => {
            ownedPluginServices.resolve(handle);
            // Transfer the pending owner to the real service handle before startup yields.
            // A replacement or same-claim recovery must keep its own published handle.
            if (
              params.pluginRuntimeClaim?.isCurrent() !== false &&
              params.shouldStartPluginServices?.(pluginServicesOwner) !== false
            ) {
              params.onPluginServices?.(handle);
            }
          },
        });
      } catch (err) {
        ownedPluginServices.resolve(null);
        params.log.warn(`plugin services failed to start: ${String(err)}`);
      }
    });
  }
  const shouldDispatchGatewayStartupInternalHook =
    internalHooksConfigured || (await hasGatewayStartupInternalHookListeners());
  if (params.shouldCreatePostReadySidecars?.() === false) {
    return 0;
  }
  if (shouldDispatchGatewayStartupInternalHook) {
    params.startupOutcomes?.record({
      subsystem: "internal-startup-hook",
      status: "scheduled",
    });
    // Run startup hooks after sidecar startup has yielded once so gateway bind
    // and channel startup are not delayed by hook handlers.
    // This timer belongs to the current gateway generation; registration lets
    // close cancel it before a replacement generation starts in the same process.
    postReadySidecars.push(
      scheduleGatewayGenerationTimer({
        scheduler: params.scheduler,
        delayMs: 250,
        origin: "hooks:gateway-startup",
        shouldRun: params.shouldCreatePostReadySidecars,
        run: async (isStopped) => {
          const { createInternalHookEvent, triggerInternalHook } = await loadInternalHooksModule();
          if (isStopped()) {
            return;
          }
          const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
            cfg: params.cfg,
            deps: params.deps,
            workspaceDir: params.defaultWorkspaceDir,
          });
          await triggerInternalHook(hookEvent);
        },
        onError: (err) => params.logHooks.warn(`gateway startup hook failed: ${String(err)}`),
      }),
    );
  }

  if (params.cfg.acp?.enabled) {
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      if (params.shouldCreatePostReadySidecars?.() === false) {
        return;
      }
      const ready = await measureStartup(params.startupTrace, "sidecars.acp.runtime-ready", () =>
        waitForAcpRuntimeBackendReady(params.cfg.acp?.backend),
      );
      params.startupTrace?.detail("sidecars.acp.runtime-ready", [
        ["readyCount", ready ? 1 : 0],
        ["backend", params.cfg.acp?.backend ?? "default"],
      ]);
      if (params.shouldCreatePostReadySidecars?.() === false) {
        return;
      }
      await measureStartup(params.startupTrace, "sidecars.acp.identity-reconcile", async () => {
        const [{ getAcpSessionManager }, { ACP_SESSION_IDENTITY_RENDERER_VERSION }] =
          await Promise.all([
            import("../acp/control-plane/manager.js"),
            import("@openclaw/acp-core/runtime/session-identifiers"),
          ]);
        if (params.shouldCreatePostReadySidecars?.() === false) {
          return;
        }
        const result = await getAcpSessionManager().reconcilePendingSessionIdentities({
          cfg: params.cfg,
        });
        if (result.checked === 0) {
          return;
        }
        params.log.warn(
          `acp startup identity reconcile (renderer=${ACP_SESSION_IDENTITY_RENDERER_VERSION}): checked=${result.checked} resolved=${result.resolved} failed=${result.failed}`,
        );
      });
    }, "startup:acp-identity-reconcile").catch((err: unknown) => {
      params.log.warn(`acp startup identity reconcile failed: ${String(err)}`);
    });
  }

  let restartSentinelWake: GatewayPostReadySidecarHandle | undefined;
  scheduleSidecar({
    name: "sidecars.restart-sentinel",
    run: async (isStopped) => {
      if (process.env.VITEST || process.env.NODE_ENV === "test" || isStopped()) {
        return;
      }
      if (!(await hasRestartSentinel(restartSentinelContext.workerContext.environment))) {
        const { assertNoRetiredRestartSentinelFiles } =
          await import("../infra/state-migrations.restart-sentinel.js");
        assertNoRetiredRestartSentinelFiles(restartSentinelContext.stateDir);
        return;
      }
      if (isStopped()) {
        return;
      }
      restartSentinelWake = scheduleRestartSentinelWakeAfterReady({
        scheduler: params.scheduler,
        context: restartSentinelContext,
        deps: params.deps,
        log: params.log,
        shouldRun: params.shouldCreatePostReadySidecars,
      });
    },
    stop: async () => {
      await restartSentinelWake?.stop();
    },
  });

  if (params.cfg.hooks?.enabled && params.cfg.hooks.gmail?.account) {
    scheduleSidecar({
      name: "sidecars.gmail-watch",
      run: async (isStopped, signal) => {
        const { startGmailWatcherWithLogs } = await import("../hooks/gmail-watcher-lifecycle.js");
        if (isStopped()) {
          return;
        }
        await startGmailWatcherWithLogs({
          cfg: params.cfg,
          log: params.logHooks,
          signal,
          scheduler: params.scheduler,
        });
      },
    });
  }

  if (params.cfg.hooks?.gmail?.model) {
    scheduleSidecar({
      name: "sidecars.gmail-model",
      run: async (isStopped) => {
        const [
          { DEFAULT_MODEL, DEFAULT_PROVIDER },
          { loadPreparedModelCatalogOwnerSnapshot },
          { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel },
        ] = await Promise.all([
          loadAgentDefaultsModule(),
          import("../agents/prepared-model-catalog.js"),
          loadAgentModelSelectionModule(),
        ]);
        if (isStopped()) {
          return;
        }
        const hooksModelRef = resolveHooksGmailModel({
          cfg: params.cfg,
          defaultProvider: DEFAULT_PROVIDER,
        });
        if (hooksModelRef) {
          const { provider: resolvedDefaultProvider, model: defaultModel } =
            resolveConfiguredModelRef({
              cfg: params.cfg,
              defaultProvider: DEFAULT_PROVIDER,
              defaultModel: DEFAULT_MODEL,
            });
          const catalog = (
            await loadPreparedModelCatalogOwnerSnapshot({ config: params.cfg, readOnly: true })
          ).modelCatalog.entries;
          if (isStopped()) {
            return;
          }
          const status = getModelRefStatus({
            cfg: params.cfg,
            catalog,
            ref: hooksModelRef,
            defaultProvider: resolvedDefaultProvider,
            defaultModel: { provider: resolvedDefaultProvider, model: defaultModel },
          });
          if (!status.allowed) {
            params.logHooks.warn(
              `hooks.gmail.model "${status.key}" not allowed by agents.defaults.modelPolicy.allow (will use primary instead)`,
            );
          }
          if (!status.inCatalog) {
            params.logHooks.warn(
              `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
            );
          }
        }
      },
    });
  }

  // These handles schedule later tasks but do not yield after creation. Transfer
  // ownership in the same turn so close cannot seal between creation and publication.
  params.onPostReadySidecars(...postReadySidecars);
  return postReadySidecars.length;
}
