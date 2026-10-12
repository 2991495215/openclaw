import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { createServiceRegistration } from "../plugins/services.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import type { startGatewayPostAttachRuntime as StartPostAttach } from "./server-startup-post-attach.js";
import type { startGatewaySidecars as StartSidecars } from "./server-startup-sidecars.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";

type PostAttachParams = Parameters<typeof StartPostAttach>[0];
type PostAttachRuntimeDeps = NonNullable<Parameters<typeof StartPostAttach>[1]>;

export function registerGatewayStartupPluginServiceTests(params: {
  startPluginServices: Mock<typeof import("../plugins/services.js").startPluginServices>;
  startGatewayPostAttachRuntime: typeof StartPostAttach;
  createPostAttachParams: (overrides?: Partial<PostAttachParams>) => PostAttachParams;
  startGatewaySidecars: (
    overrides?: Partial<Parameters<typeof StartSidecars>[0]>,
  ) => ReturnType<typeof StartSidecars>;
  createPostAttachRuntimeDeps: (
    overrides?: Partial<PostAttachRuntimeDeps>,
  ) => PostAttachRuntimeDeps;
  waitForGatewayTestState: <T>(assertion: () => T | Promise<T>) => Promise<T>;
  createStartupTraceRecorder: () => { startupTrace: GatewayStartupTrace };
  createPluginServicesOwner: () => ReturnType<typeof createGatewayPluginRuntimeGeneration>;
}): void {
  const {
    startPluginServices,
    startGatewayPostAttachRuntime,
    createPostAttachParams,
    startGatewaySidecars,
    createPostAttachRuntimeDeps,
    waitForGatewayTestState,
    createStartupTraceRecorder,
    createPluginServicesOwner,
  } = params;

  it("starts and reports plugin services after channel startup completes", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let releaseChannels: (() => void) | undefined;
        const events: string[] = [];
        const pluginServices: PluginServicesHandle = {
          reload: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
        };
        const onPluginServices = vi.fn();
        const onSidecarsReady = vi.fn();
        const startChannels = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              events.push("channels-start");
              releaseChannels = () => {
                events.push("channels-end");
                resolve();
              };
            }),
        );
        startPluginServices.mockImplementationOnce(async (params) => {
          events.push("plugin-services");
          params.onHandle?.(pluginServices);
          return pluginServices;
        });

        await startGatewayPostAttachRuntime({
          ...createPostAttachParams({
            sidecarStartup: "defer",
            onChannelsStarted: async () => {
              events.push("channels-started");
            },
            onPluginServices,
            onSidecarsReady,
          }),
          startChannels,
        });

        await waitForGatewayTestState(() => {
          expect(startChannels).toHaveBeenCalledTimes(1);
        });
        expect(startPluginServices).not.toHaveBeenCalled();
        expect(onPluginServices).not.toHaveBeenCalled();
        expect(onSidecarsReady).not.toHaveBeenCalled();

        if (!releaseChannels) {
          throw new Error("Expected channel startup release callback to be initialized");
        }
        releaseChannels();
        await waitForGatewayTestState(() => {
          expect(startPluginServices).toHaveBeenCalledTimes(1);
          expect(onPluginServices).toHaveBeenCalledTimes(2);
          expect(onPluginServices).toHaveBeenLastCalledWith(pluginServices);
          expect(onSidecarsReady).toHaveBeenCalledTimes(1);
        });
        expect(events).toEqual([
          "channels-start",
          "channels-started",
          "channels-end",
          "plugin-services",
        ]);
        expect(onPluginServices).toHaveBeenCalledTimes(2);
        const owner: PluginServicesHandle = onPluginServices.mock.calls[0]?.[0];
        const config: OpenClawConfig = { diagnostics: { otel: { enabled: true } } };
        const selected = new Set(["exporter"]);
        await owner.reload(config, selected);
        expect(pluginServices.reload).toHaveBeenCalledExactlyOnceWith(config, selected);
        await owner.stop();
        expect(pluginServices.stop).toHaveBeenCalledOnce();
      },
    );
  });

  it("does not start plugin services after deferred close starts during channel startup", async () => {
    const channels = createDeferred();
    let closing = false;
    const onPluginServices = vi.fn();
    const onSidecarsReady = vi.fn();
    const startChannels = vi.fn(() => channels.promise);
    const runtime = await startGatewayPostAttachRuntime(
      createPostAttachParams({
        sidecarStartup: "defer",
        onPluginServices,
        onSidecarsReady,
        startChannels,
        isClosing: () => closing,
      }),
    );
    try {
      await waitForGatewayTestState(() => expect(startChannels).toHaveBeenCalledOnce());
      closing = true;
      channels.resolve();
      await runtime.startupSettled;
      expect(onSidecarsReady).not.toHaveBeenCalled();
      expect(startPluginServices).not.toHaveBeenCalled();
      expect(onPluginServices).not.toHaveBeenCalled();
    } finally {
      channels.resolve();
      await runtime.startupSettled;
    }
  });

  it("keeps published service lifetime with its owner during Gateway close", async () => {
    const actualServices =
      await vi.importActual<typeof import("../plugins/services.js")>("../plugins/services.js");
    startPluginServices.mockImplementationOnce(actualServices.startPluginServices);
    const registry = createEmptyPluginRegistry();
    const siblingStarted = createDeferred();
    const releaseSibling = createDeferred();
    const serviceStop = vi.fn();
    const broadcastPluginEvent = vi.fn();
    let emit: (() => void) | undefined;
    registry.services.push(
      createServiceRegistration(
        {
          id: "published-startup-service",
          start: (context) => {
            emit = () => context.gatewayEvents?.emit("ready", {}, { scope: "operator.read" });
            registerPluginHttpRoute({
              path: "/published-startup-service",
              auth: "plugin",
              handler: vi.fn(),
            });
          },
          stop: serviceStop,
        },
        { pluginId: "published-startup" },
      ),
      createServiceRegistration(
        {
          id: "blocked-startup-service",
          start: () => {
            siblingStarted.resolve();
            return releaseSibling.promise;
          },
        },
        { pluginId: "blocked-startup" },
      ),
    );
    let services: PluginServicesHandle | null = null;
    const generation = createGatewayPluginRuntimeGeneration({
      getServices: () => services,
      setServices: (next) => {
        services = next;
      },
    });
    const claim = generation.currentClaim();
    const onPluginServices = vi.fn((handle: PluginServicesHandle | null) => {
      generation.publishServices(claim, handle);
    });
    let closing = false;
    const base = createPostAttachParams();
    const sidecarsPromise = startGatewaySidecars({
      cfg: base.cfgAtStart,
      pluginRegistry: registry,
      defaultWorkspaceDir: base.defaultWorkspaceDir,
      deps: base.deps,
      shouldStartPluginServices: () => !closing && claim.isCurrent(),
      shouldCreatePostReadySidecars: () => false,
      pluginRuntimeClaim: claim,
      onPluginServices,
      broadcastPluginEvent,
      log: base.log,
      logHooks: base.logHooks,
      logChannels: base.logChannels,
    });
    try {
      await siblingStarted.promise;
      const owner = generation.currentServices();
      if (!owner) {
        throw new Error("plugin service owner was not published before startup yielded");
      }
      expect(registry.httpRoutes.map((route) => route.path)).toEqual([
        "/published-startup-service",
      ]);
      emit?.();
      expect(broadcastPluginEvent).toHaveBeenCalledOnce();

      closing = true;
      releaseSibling.resolve();
      await sidecarsPromise;

      expect(generation.currentServices()).toBe(owner);
      expect(onPluginServices).toHaveBeenLastCalledWith(owner);
      expect(serviceStop).not.toHaveBeenCalled();
      expect(registry.httpRoutes.map((route) => route.path)).toEqual([
        "/published-startup-service",
      ]);
      emit?.();
      expect(broadcastPluginEvent).toHaveBeenCalledTimes(2);
    } finally {
      releaseSibling.resolve();
      await sidecarsPromise;
      await generation.currentServices()?.stop();
    }
  });

  it("releases tracked startup after strict timeout while retaining service cleanup", async () => {
    vi.useFakeTimers();
    const actualServices =
      await vi.importActual<typeof import("../plugins/services.js")>("../plugins/services.js");
    startPluginServices.mockImplementationOnce(actualServices.startPluginServices);
    const startupEntered = createDeferred();
    const startup = createDeferred();
    const cleanup = createDeferred();
    const serviceStop = vi.fn(() => cleanup.promise);
    const registry = createEmptyPluginRegistry();
    registry.services.push(
      createServiceRegistration(
        {
          id: "retained-startup-cleanup",
          start: () => {
            startupEntered.resolve();
            return startup.promise;
          },
          stop: serviceStop,
        },
        { pluginId: "retained-startup-cleanup" },
      ),
    );
    const publishedOwner: { current: PluginServicesHandle | null } = { current: null };
    const generation = createGatewayPluginRuntimeGeneration({
      getServices: () => publishedOwner.current,
      setServices: (handle) => {
        publishedOwner.current = handle;
      },
    });
    const claim = generation.currentClaim();
    const connectionWork = new GatewayConnectionWork();
    const base = createPostAttachParams();
    const operation = Promise.resolve().then(() =>
      startGatewaySidecars({
        cfg: base.cfgAtStart,
        pluginRegistry: registry,
        defaultWorkspaceDir: base.defaultWorkspaceDir,
        deps: base.deps,
        shouldCreatePostReadySidecars: () => false,
        pluginRuntimeClaim: claim,
        onPluginServices: (handle) => {
          generation.publishServices(claim, handle);
        },
        log: base.log,
        logHooks: base.logHooks,
        logChannels: base.logChannels,
      }),
    );
    const starting = connectionWork.track(() => operation);
    let replacing: Promise<unknown> | undefined;
    let draining: Promise<void> | undefined;
    let finalCleanup: Promise<void> | undefined;
    let reservation: ReturnType<typeof generation.reserve> | undefined;

    try {
      await startupEntered.promise;
      const owner = generation.currentServices();
      if (!owner) {
        throw new Error("plugin service owner was not published before startup yielded");
      }
      reservation = generation.reserve();
      replacing = owner
        .stop({
          strict: true,
          deadlineAtMs: Date.now() + actualServices.PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(actualServices.PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
      expect(await replacing).toBeInstanceOf(AggregateError);
      expect(serviceStop).not.toHaveBeenCalled();
      reservation.reject();
      startup.resolve();

      let drained = false;
      draining = connectionWork.drain().then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(true);
      expect(serviceStop).toHaveBeenCalledOnce();
      expect(generation.currentServices()).toBe(owner);

      let cleanupSettled = false;
      finalCleanup = owner.stop().then(() => {
        cleanupSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanupSettled).toBe(false);
      expect(serviceStop).toHaveBeenCalledOnce();
      cleanup.resolve();
      await finalCleanup;
      expect(cleanupSettled).toBe(true);
      expect(serviceStop).toHaveBeenCalledOnce();
    } finally {
      reservation?.reject();
      startup.resolve();
      cleanup.resolve();
      await Promise.allSettled([starting, replacing, draining, finalCleanup]);
      await generation.currentServices()?.stop();
    }
  });

  it("settles pending service cleanup before its replacement reservation completes", async () => {
    const generation = createPluginServicesOwner();
    const startupClaim = generation.currentClaim();
    const replacementWaitEntered = createDeferred();
    let reservation: ReturnType<typeof generation.reserve> | undefined;
    let shouldStartPluginServices = true;
    let stopping: ReturnType<PluginServicesHandle["stop"]> | undefined;
    let stopped = false;
    const stopPublishedServices = () => {
      const handle = generation.currentServices();
      if (!handle) {
        throw new Error("plugin service cleanup owner was not published");
      }
      shouldStartPluginServices = false;
      stopping = handle.stop().then(() => {
        stopped = true;
      });
    };
    const onPluginServices = vi.fn((handle: PluginServicesHandle | null) => {
      if (!handle) {
        return;
      }
      generation.publishServices(startupClaim, handle);
      reservation = generation.reserve();
    });

    const starting = startGatewaySidecars({
      pluginRuntimeClaim: {
        ...startupClaim,
        waitForUnblocked: () => {
          const waiting = startupClaim.waitForUnblocked();
          if (reservation) {
            replacementWaitEntered.resolve();
          }
          return waiting;
        },
      },
      shouldStartPluginServices: () => shouldStartPluginServices,
      onPluginServices,
    });

    try {
      await replacementWaitEntered.promise;
      stopPublishedServices();
      // Replacement can settle its reservation only after the previous owner drains.
      await waitForGatewayTestState(() => expect(stopped).toBe(true));
      reservation?.commit();
      await starting;
      expect(startPluginServices).not.toHaveBeenCalled();
      expect(onPluginServices).toHaveBeenCalledOnce();
    } finally {
      reservation?.reject();
      await Promise.allSettled([starting, stopping]);
    }
  });

  it.each(["settles", "times out", "has no deadline"] as const)(
    "forwards strict cleanup through the deferred plugin service owner when it %s",
    async (strictOutcome) => {
      vi.useFakeTimers();
      const callbackFailure = { errors: [new Error("synthetic callback cleanup failure")] };
      const cleanup = createDeferred<typeof callbackFailure>();
      const strictCleanup = createDeferred();
      const serviceStop = vi.fn<PluginServicesHandle["stop"]>((options) => {
        if (options?.strict) {
          return strictOutcome === "settles" ? Promise.resolve() : strictCleanup.promise;
        }
        return cleanup.promise;
      });
      const startedServices = { reload: vi.fn(async () => {}), stop: serviceStop };
      const publishedOwner: { current: PluginServicesHandle | null } = { current: null };
      startPluginServices.mockImplementationOnce(async (params) => {
        params.onHandle?.(startedServices);
        return startedServices;
      });

      await startGatewaySidecars({
        onPluginServices: (handle) => {
          publishedOwner.current ??= handle;
        },
      });

      const owner = publishedOwner.current;
      if (!owner) {
        throw new Error("deferred plugin service owner was not published");
      }
      const replacement = {
        strict: true,
        ...(strictOutcome === "has no deadline" ? {} : { deadlineAtMs: Date.now() + 5_000 }),
      } as const;
      const replacing = owner.stop(replacement);
      let replacementSettled = false;
      const replacementResult = replacing.then(
        () => {
          replacementSettled = true;
        },
        (error: unknown) => {
          replacementSettled = true;
          return error;
        },
      );
      let stopping: ReturnType<PluginServicesHandle["stop"]> | undefined;

      try {
        if (strictOutcome === "settles") {
          await replacing;
          expect(serviceStop).toHaveBeenCalledWith(replacement);
          return;
        }

        await vi.advanceTimersByTimeAsync(5_000);
        if (strictOutcome === "has no deadline") {
          expect(replacementSettled).toBe(false);
          expect(serviceStop).toHaveBeenCalledWith(replacement);
          strictCleanup.resolve();
          await expect(replacing).resolves.toBeUndefined();
          return;
        }
        expect(await replacementResult).toBeInstanceOf(AggregateError);
        strictCleanup.reject(new Error("strict service cleanup timed out"));
        await vi.advanceTimersByTimeAsync(0);

        let stopped = false;
        stopping = owner.stop();
        void stopping.then(
          () => {
            stopped = true;
          },
          () => {
            stopped = true;
          },
        );
        await vi.advanceTimersByTimeAsync(0);

        expect(stopped).toBe(false);
        expect(serviceStop.mock.calls.map(([options]) => options)).toEqual([
          replacement,
          undefined,
        ]);
        cleanup.resolve(callbackFailure);
        await expect(stopping).resolves.toBe(callbackFailure);
      } finally {
        strictCleanup.resolve();
        cleanup.resolve(callbackFailure);
        await Promise.allSettled([replacing, stopping]);
      }
    },
  );

  it("publishes the actual plugin cleanup owner before service startup", async () => {
    const actualServices =
      await vi.importActual<typeof import("../plugins/services.js")>("../plugins/services.js");
    const registry = createEmptyPluginRegistry();
    const start = vi.fn();
    registry.services.push(
      createServiceRegistration(
        { id: "close-before-start", start },
        { pluginId: "close-before-start" },
      ),
    );
    let actualOwner: PluginServicesHandle | undefined;
    startPluginServices.mockImplementationOnce((params) =>
      actualServices.startPluginServices({
        ...params,
        onHandle: (handle) => {
          actualOwner = handle;
          params.onHandle?.(handle);
        },
      }),
    );
    let closing = false;
    let stopping: ReturnType<PluginServicesHandle["stop"]> | undefined;
    const onPluginServices = vi.fn((handle: PluginServicesHandle | null) => {
      if (handle && handle === actualOwner) {
        closing = true;
        stopping = handle.stop();
      }
    });

    await startGatewaySidecars({
      cfg: {},
      pluginRegistry: registry,
      shouldStartPluginServices: () => !closing,
      shouldCreatePostReadySidecars: () => !closing,
      onPluginServices,
    });

    await stopping;
    expect(startPluginServices).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(onPluginServices).toHaveBeenCalledTimes(2);
  });

  it.each(["close", "commit", "recovery", "reject"] as const)(
    "revalidates deferred service admission after %s during lazy loading",
    async (transition) => {
      const actualServices =
        await vi.importActual<typeof import("../plugins/services.js")>("../plugins/services.js");
      const registry = createEmptyPluginRegistry();
      const service = { id: "admission", start: vi.fn(), stop: vi.fn() };
      registry.services.push(createServiceRegistration(service, { pluginId: "admission" }));
      const scheduler = createTestGatewayScheduler(vi.isFakeTimers() ? "fake-timers" : undefined);
      const replacementHandle =
        transition === "commit" || transition === "recovery"
          ? await actualServices.startPluginServices({ registry, config: {}, scheduler })
          : null;
      startPluginServices.mockImplementationOnce(actualServices.startPluginServices);
      const owner = createPluginServicesOwner();
      const startupClaim = owner.currentClaim();
      const importEntered = createDeferred();
      let closing = false;
      let reservation: ReturnType<typeof owner.reserve> | undefined;
      const onPluginServices = vi.fn((handle: PluginServicesHandle | null) => {
        owner.publishServices(startupClaim, handle);
      });
      const trace = createStartupTraceRecorder();
      const runtime = await startGatewayPostAttachRuntime(
        createPostAttachParams({
          scheduler,
          sidecarStartup: "defer",
          pluginRegistry: registry,
          pluginRuntimeClaim: startupClaim,
          getCurrentPluginServices: owner.currentServices,
          onPluginServices,
          isClosing: () => closing,
          startupTrace: {
            ...trace.startupTrace,
            measure: async <T>(name: string, run: () => T | Promise<T>) => {
              const operation = run();
              if (name === "sidecars.plugin-services") {
                // run() has reached the dynamic import's await. Rotate ownership in
                // the same turn so admission must revalidate after that import.
                reservation = owner.reserve();
                if (transition === "commit") {
                  reservation.commit();
                  owner.publishServices(reservation.claim, replacementHandle);
                } else if (transition !== "reject") {
                  reservation.reject();
                  closing = transition === "close";
                  if (transition === "recovery") {
                    owner.publishServices(startupClaim, replacementHandle);
                  }
                }
                importEntered.resolve();
              }
              return await operation;
            },
          },
        }),
        createPostAttachRuntimeDeps({ startGatewaySidecars }),
      );
      try {
        await importEntered.promise;
        if (transition === "reject") {
          expect(startPluginServices).not.toHaveBeenCalled();
          reservation?.reject();
        }
        await runtime.startupSettled;
        expect(service.start).toHaveBeenCalledTimes(transition === "close" ? 0 : 1);
        expect(startPluginServices).toHaveBeenCalledTimes(transition === "reject" ? 1 : 0);
        expect(onPluginServices).toHaveBeenCalledTimes(transition === "reject" ? 2 : 1);
        if (transition === "close") {
          expect(owner.currentServices()).toBe(onPluginServices.mock.calls[0]?.[0]);
        } else if (transition !== "reject") {
          expect(owner.currentServices()).toBe(replacementHandle);
        }
      } finally {
        reservation?.reject();
        await runtime.startupSettled;
        for (const handle of new Set([replacementHandle, ...onPluginServices.mock.calls.flat()])) {
          await handle?.stop();
        }
      }
    },
  );
}
