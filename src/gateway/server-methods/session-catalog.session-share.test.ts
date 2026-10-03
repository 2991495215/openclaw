import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  bindPluginRegistryRuntime,
  call as callCatalog,
  hoisted,
  resetSessionCatalogTestState,
  startCall,
  type PluginRegistry,
} from "./session-catalog.test-helpers.js";

const { default: sessionSharePlugin } = await loadBundledPluginFacade<{
  default: { register: (api: OpenClawPluginApi) => void };
}>({ pluginId: "session-share", artifactBasename: "index.js" });

it("bounds six Gateway connections and filters the shared refresh at each delivery", async () => {
  resetSessionCatalogTestState();
  vi.useFakeTimers();
  const row = {
    threadId: "agent:main:shared",
    name: "Shared session",
    status: "idle",
    archived: false,
    canContinue: false,
    canArchive: false,
  };
  const invokeNode = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30_000);
    });
    return { sessions: [row] };
  });
  const config = {};
  const runtime = createPluginRuntimeMock({
    config: { current: () => config },
    nodes: {
      list: async () => ({
        nodes: [
          {
            nodeId: "source",
            connected: true,
            commands: ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"],
          },
        ],
      }),
      invoke: async () => {
        throw new Error("must use service authority");
      },
    },
  });
  let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  const api = createTestPluginApi({
    runtime,
    registerService: (registered) => {
      service = registered;
    },
    registerSessionCatalog: (provider) => {
      hoisted.activeRegistry.sessionCatalogs = [{ provider }];
    },
  });
  sessionSharePlugin.register(api);
  const scheduler = createTestPluginServiceScheduler();
  const context = { config, logger: api.logger, stateDir: "/unused", invokeNode, scheduler };
  await service?.start(context);
  bindPluginRegistryRuntime(hoisted.activeRegistry as PluginRegistry, runtime);
  hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
  const clients = Array.from({ length: 6 }, (_, index) => ({
    connId: `viewer-${index}`,
    connect: { scopes: ["operator.admin"] },
  }));
  const broadcasts = clients.map(() => vi.fn());
  const elapsed: number[] = [];
  const started = Date.now();
  try {
    const calls = clients.map((client, index) =>
      startCall(
        "sessions.catalog.list",
        { catalogId: "openclaw", progressId: `progress-${index}`, allowPartialResults: true },
        config,
        client,
        { broadcastToConnIds: broadcasts[index] },
      ),
    );
    const done = Promise.all(
      calls.map(async (call) => {
        await call.completion;
        elapsed.push(Date.now() - started);
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(elapsed).toHaveLength(6);
    expect(Math.max(...elapsed)).toBeLessThanOrEqual(1_000);
    expect(invokeNode).toHaveBeenCalledTimes(1);
    for (const call of calls) {
      expect(call.respond).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            hosts: [],
            error: expect.objectContaining({ code: "catalog_pending" }),
          }),
        ],
      });
    }
    clients[5]!.connect.scopes = ["operator.read"];
    await vi.advanceTimersByTimeAsync(29_000);
    await done;
    for (const [index, broadcast] of broadcasts.entries()) {
      expect(broadcast).toHaveBeenLastCalledWith(
        "sessions.catalog.host",
        expect.objectContaining({
          catalog: expect.objectContaining({
            hosts: [
              expect.objectContaining({
                sessions: index === 5 ? [] : [expect.objectContaining(row)],
              }),
            ],
          }),
        }),
        new Set([clients[index]!.connId]),
        { dropIfSlow: true },
      );
    }
    console.log(
      JSON.stringify({
        gatewayP99Ms: Math.max(...elapsed),
        invocations: invokeNode.mock.calls.length,
      }),
    );
  } finally {
    await vi.runAllTimersAsync();
    scheduler.beginClose();
    try {
      await service?.stop?.(context);
    } finally {
      await scheduler.stop();
    }
    vi.useRealTimers();
  }
});

it.each(["pending", "failed"] as const)(
  "withdraws a warmed source-authorized page during a %s refresh on the same connection",
  async (outcome) => {
    resetSessionCatalogTestState();
    vi.useFakeTimers();
    const row = {
      threadId: "agent:main:revoked",
      name: "Previously authorized source session",
      status: "idle",
      archived: false,
      canContinue: false,
      canArchive: false,
    };
    let release: (() => void) | undefined;
    let sourceAuthorized = true;
    const invokeNode = vi.fn(async () => {
      if (!sourceAuthorized) {
        if (outcome === "failed") {
          throw new Error("Source authorization unavailable");
        }
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { sessions: sourceAuthorized ? [row] : [] };
    });
    const config = {};
    const runtime = createPluginRuntimeMock({
      config: { current: () => config },
      nodes: {
        list: async () => ({
          nodes: [
            {
              nodeId: "source",
              connected: true,
              commands: ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"],
            },
          ],
        }),
      },
    });
    let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
    const api = createTestPluginApi({
      runtime,
      registerService: (registered) => {
        service = registered;
      },
      registerSessionCatalog: (provider) => {
        hoisted.activeRegistry.sessionCatalogs = [{ provider }];
      },
    });
    sessionSharePlugin.register(api);
    const scheduler = createTestPluginServiceScheduler();
    const context = { config, logger: api.logger, stateDir: "/unused", invokeNode, scheduler };
    await service?.start(context);
    bindPluginRegistryRuntime(hoisted.activeRegistry as PluginRegistry, runtime);
    const client = { connId: "same-viewer", connect: { scopes: ["operator.admin"] } };
    const request = { catalogId: "openclaw" };
    try {
      const warm = await callCatalog("sessions.catalog.list", request, config, client);
      expect(warm.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([
        expect.objectContaining(row),
      ]);
      sourceAuthorized = false;
      const refresh = startCall("sessions.catalog.list", request, config, client);
      await vi.advanceTimersByTimeAsync(1_000);
      await refresh.completion;
      const result = refresh.respond.mock.calls[0]?.[1]?.catalogs[0];
      expect(result.hosts.flatMap((host: { sessions: unknown[] }) => host.sessions)).toEqual([]);
      expect(invokeNode).toHaveBeenCalledTimes(2);
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      sourceAuthorized = true;
      const restored = await callCatalog("sessions.catalog.list", request, config, client);
      expect(restored.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([
        expect.objectContaining(row),
      ]);
    } finally {
      release?.();
      await vi.runAllTimersAsync();
      scheduler.beginClose();
      try {
        await service?.stop?.(context);
      } finally {
        await scheduler.stop();
      }
      vi.useRealTimers();
    }
  },
);
