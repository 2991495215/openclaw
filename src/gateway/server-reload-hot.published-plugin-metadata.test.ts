import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getPluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createDefaultGatewayReloadState,
  createHotTailPlan,
} from "./server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";

const loadPluginMetadataSnapshot = vi.hoisted(() => vi.fn());
const reviveAgentDatabasesAfterConfigCommit = vi.hoisted(() => vi.fn());
vi.mock("./server-reload-agent-databases.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-reload-agent-databases.js")>()),
  reviveAgentDatabasesAfterConfigCommit,
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>();
  loadPluginMetadataSnapshot.mockImplementation(actual.loadPluginMetadataSnapshot);
  return { ...actual, loadPluginMetadataSnapshot };
});

const registry = createEmptyPluginRegistry();
beforeEach(() => {
  setActivePluginRegistry(registry);
  loadPluginMetadataSnapshot.mockClear();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearCurrentPluginMetadataSnapshot();
  resetPluginRuntimeStateForTest();
});

it("agent database revival after a reload commit reads the published plugin inventory", async () => {
  await withOpenClawTestState({ label: "post-commit-plugin-metadata" }, async () => {
    const config: OpenClawConfig = {};
    setRuntimeConfigSnapshot(config);
    setGatewayPluginMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [{ id: "fixture", providerAuthAliases: { "fixture-alias": "fixture" } }],
      }),
      { config },
    );
    const resolvedProviders: string[] = [];
    reviveAgentDatabasesAfterConfigCommit.mockImplementation(async () => {
      resolvedProviders.push(resolveProviderIdForAuth("fixture-alias", { config }));
    });
    let state = createDefaultGatewayReloadState();
    const handlers = createGatewayReloadHandlers({
      scheduler: createTestGatewayScheduler("fake-timers"),
      getPluginRegistry: () => registry,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => state,
      setState: (nextState) => {
        state = nextState;
      },
      startChannel: vi.fn(async () => new Map()),
      stopChannel: vi.fn(async () => {}),
      releaseChannelRouteHandoffs: vi.fn(),
      pruneInactiveChannelAccountState: vi.fn(),
      reloadPlugins: vi.fn(),
      logHooks: createInfoWarnErrorLogger(),
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      cronReconciliation: { invalidate: vi.fn() } as never,
    });
    let commitCacheKind: string | undefined;

    await withPluginLifecycleLease({}, () =>
      handlers.applyHotReload(createHotTailPlan({ refreshHooksPolicy: true }), config, {
        sourceConfig: config,
        isCurrent: () => true,
        publish: async (commit) => {
          // Management before and at the commit keeps the lease's fresh operation cache.
          commitCacheKind = getPluginCache().kind;
          await commit();
        },
      }),
    );

    expect(commitCacheKind).toBe("operation");
    expect(resolvedProviders).toEqual(["fixture"]);
    expect(loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });
});
