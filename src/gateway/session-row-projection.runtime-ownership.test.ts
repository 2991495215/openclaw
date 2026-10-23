import { performance } from "node:perf_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { AgentHarnessPreflightError } from "../agents/harness/errors.js";
import type { AgentHarness } from "../agents/harness/types.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  beginPluginStatePublication,
  pluginStatePublication,
  pluginStatePublicationKey,
} from "../plugin-state/plugin-state-publication.js";
import { createPluginStateKeyedStoreV2 } from "../plugin-state/plugin-state-store.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import {
  createTestProjection,
  holdForeground,
} from "./session-row-projection.read-fixture.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function nativeHarness(
  resolve: NonNullable<AgentHarness["resolveSessionRuntimeOwnershipAsync"]>,
  sync?: AgentHarness["resolveSessionRuntimeOwnership"],
) {
  const previous = captureActivePluginRegistrySnapshot();
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "row-native",
    source: "test",
    harness: {
      id: "row-native",
      label: "Native row fixture",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("Presentation must not run a model");
      },
      resolveSessionRuntimeOwnershipAsync: resolve,
      ...(sync ? { resolveSessionRuntimeOwnership: sync } : {}),
    },
  });
  setActivePluginRegistry(registry);
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "row-native", activation: { onAgentHarnesses: ["row-native"] } }],
  });
  return {
    registry,
    metadataSnapshot,
    [Symbol.dispose]: () => restoreActivePluginRegistrySnapshot(previous),
  };
}

const defaultConfig = {
  agents: { entries: { main: {} }, defaults: { model: { primary: "openai/gpt-5.5" } } },
};

function seedNative(key: string, sessionId: string, extra: Partial<SessionEntry> = {}) {
  const entry = {
    sessionId,
    updatedAt: 1,
    agentHarnessId: "row-native",
    modelSelectionLocked: true,
    ...extra,
  };
  replaceSessionEntrySync({ agentId: "main", sessionKey: key }, entry);
  return entry;
}

function catalogFor(
  config: OpenClawConfig,
  native: ReturnType<typeof nativeHarness>,
  id: string,
  name = id,
) {
  return new Map([
    [
      "main",
      createPreparedGatewayModelCatalog({
        config,
        entries: [{ provider: "example", id, name }],
        pluginRegistry: native.registry,
        metadataSnapshot: native.metadataSnapshot,
      }),
    ],
  ]);
}

function expectListed(respond: ReturnType<typeof vi.fn>, sessions: Record<string, unknown>[]) {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      sessions: sessions.map((row) => expect.objectContaining(row)),
    }),
  );
}

it("rereads native model ownership after its harness plugin config changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:harness:row-native:config";
    const bindings = createPluginStateKeyedStoreV2<string>(
      "row-native",
      { namespace: "config-bindings", maxEntries: 10 },
      { assertCurrent() {} },
    );
    await bindings.register(key, "present");
    seedNative(key, "native-config");
    const config = (model: string): OpenClawConfig => ({
      agents: { entries: { main: {} }, defaults: { model: "example/fallback" } },
      plugins: { entries: { "row-native": { enabled: true, config: { model } } } },
    });
    let cfg = config("original-native");
    setRuntimeConfigSnapshot(cfg);
    const native = nativeHarness(async (params) => {
      await bindings.lookup(params.sessionKey!);
      return {
        model: "native",
        auth: "native",
        modelRef: {
          provider: "example",
          model: String(cfg.plugins!.entries!["row-native"]!.config!.model),
        },
      };
    });
    const view = () => catalogFor(cfg, native, "fallback", "Fallback");
    let catalog = view();
    const release = retainSessionListForegroundWork();
    let projection: SessionRowProjection | undefined;
    try {
      projection = await createSessionRowProjection({
        cfg,
        getConfig: () => cfg,
        getModelCatalog: async () => catalog,
      });
      expect((await listProjectedSessions({ projection, opts: {} })).sessions[0]?.model).toBe(
        "original-native",
      );
      cfg = config("replacement-native");
      setRuntimeConfigSnapshot(cfg);
      catalog = view();
      notifyPreparedModelRuntimePublication({ phase: "published" });
      await projection.ensureMaterialized();
      expect((await listProjectedSessions({ projection, opts: {} })).sessions[0]?.model).toBe(
        "replacement-native",
      );
    } finally {
      projection?.dispose();
      release();
      native[Symbol.dispose]();
      resetConfigRuntimeState();
    }
  });
});

it("keeps archived native sessions searchable after catalog replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: { entries: { main: {} }, defaults: { model: "example/fallback" } },
    };
    const archivedKey = "agent:main:harness:row-native:archived";
    seedNative(archivedKey, "archived-native", { archivedAt: 1 });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:dashboard:scheduled-target" },
      { sessionId: "scheduled-target", updatedAt: 2 },
    );
    let nativeModel = "original-native";
    using native = nativeHarness(async () => ({
      model: "native",
      auth: "native",
      modelRef: { provider: "example", model: nativeModel },
    }));
    using _ = holdForeground();
    using projection = await createTestProjection({
      cfg,
      getModelCatalog: async () => catalogFor(cfg, native, nativeModel),
    });
    const respond = vi.fn();
    const list = async (search?: string, archived: boolean | "all" = "all") => {
      respond.mockClear();
      await sessionReadHandlers["sessions.list"]!({
        req: { type: "req", id: "archived-native-search", method: "sessions.list" },
        params: { agentId: "main", search, archived, limit: 5, includeLastMessage: false },
        client: null,
        context: bindSessionRowProjection(requestContext(cfg), () => projection!),
        isWebchatConnect: () => false,
        respond,
      });
    };
    await list(undefined, true);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessions: expect.arrayContaining([
          expect.objectContaining({ sessionId: "archived-native", model: "original-native" }),
        ]),
      }),
    );
    await list("scheduled-target");
    const expectTarget = () => expectListed(respond, [{ sessionId: "scheduled-target" }]);
    expectTarget();
    nativeModel = "replacement-native";
    notifyPreparedModelRuntimePublication({ phase: "published" });
    await projection.ensureMaterialized();
    await list("scheduled-target");
    expectTarget();
    await list("replacement-native");
    expectListed(respond, [{ sessionId: "archived-native", model: "replacement-native" }]);
  });
});

it.for(["change", "failure"] as const)(
  "keeps native ownership changes local to one listed row: %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = defaultConfig;
      const key = "agent:main:harness:row-native:changing";
      for (const sessionKey of [key, "agent:main:dashboard:unaffected"]) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey === key ? "changing" : "unaffected",
            updatedAt: sessionKey === key ? 2 : 1,
            ...(sessionKey === key
              ? { agentHarnessId: "row-native", modelSelectionLocked: true }
              : {}),
          },
        );
      }
      const failure = new AgentHarnessPreflightError("Synthetic native read failure");
      let reads = 0;
      let changing = false;
      using native = nativeHarness(async (params) => {
        reads++;
        if (changing && change === "failure") {
          throw failure;
        }
        if (changing) {
          const registration = native.registry.agentHarnesses[0]!;
          registration.harness = { ...registration.harness };
          params.assertCurrent?.();
        }
        return {
          model: "native",
          auth: "native",
          modelRef: { provider: "openai", model: "gpt-5.6-sol" },
        };
      });
      using _ = holdForeground();
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      await projection.ensureMaterialized();
      expect(projection.needsMaterialization).toBe(false);
      const initialReads = reads;
      const sql = observeHostDataSql();
      try {
        expect(projection.snapshot({ agentId: "main", key })).toEqual({ row: null });
        expect(sql.queries).toEqual([]);
        expect(reads).toBe(initialReads);
      } finally {
        sql.restore();
      }
      expect((await listProjectedSessions({ projection, opts: {} })).sessions[0]).toMatchObject({
        sessionId: "changing",
        model: "gpt-5.6-sol",
      });
      changing = true;
      reads = 0;
      sessionChanges.emit({ agentId: "main", sessionKey: key, factsInvalidated: true });
      const respond = vi.fn();
      const list = (id: string) =>
        sessionReadHandlers["sessions.list"]!({
          req: { type: "req", id, method: "sessions.list" },
          params: {},
          client: null,
          context: bindSessionRowProjection(requestContext(cfg), () => projection!),
          isWebchatConnect: () => false,
          respond,
        });
      const request = list("ownership-change-list");
      if (change === "failure") {
        await expect(request).rejects.toBe(failure);
        expect(respond).not.toHaveBeenCalled();
      } else {
        await request;
        const expectModels = (model: string) =>
          expectListed(respond, [{ sessionId: "changing", model }, { sessionId: "unaffected" }]);
        expectModels("gpt-5.5");
        expect(reads).toBe(1);
        changing = false;
        respond.mockClear();
        await list("ownership-stable-list");
        expectModels("gpt-5.5");
        expect(reads).toBe(1);

        sessionChanges.emit({ agentId: "main", sessionKey: key, factsInvalidated: true });
        respond.mockClear();
        await list("ownership-invalidated-list");
        expectModels("gpt-5.6-sol");
        expect(reads).toBe(2);
      }
    });
  },
);

it("prepares native model ownership in workers and invalidates only its committed binding", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:harness:row-native:session";
    const bindings = createPluginStateKeyedStoreV2<string>(
      "row-native",
      { namespace: "bindings", maxEntries: 10 },
      { assertCurrent() {} },
    );
    await bindings.register(key, "gpt-5.6-sol");
    const entry = seedNative(key, "row-native-session");
    let ownershipReads = 0;
    const syncOwnership = vi.fn(() => {
      throw new Error("Native row ownership must be read asynchronously");
    });
    using native = nativeHarness(async (params) => {
      ownershipReads++;
      const model = await bindings.lookup(params.sessionKey!);
      return model
        ? { model: "native", auth: "native", modelRef: { provider: "openai", model } }
        : undefined;
    }, syncOwnership);
    using _ = holdForeground();
    void native;
    using projection = await createTestProjection({
      cfg: defaultConfig,
      modelCatalog: [],
    });
    await projection.ensureMaterialized();
    const snapshot = () => projection!.snapshot({ agentId: "main", key }).row;
    snapshot();
    const initialRevision = snapshot()?.sessionModelRevision;
    expect(initialRevision).toEqual(expect.any(String));
    const sql = observeHostDataSql();
    try {
      expect(snapshot()).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-sol" });
      expect(snapshot()).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-sol" });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { ...entry, label: "Renamed native session", updatedAt: 2, lastReadAt: 2 },
    );
    await projection.ensureMaterialized();
    expect(snapshot()).toMatchObject({
      label: "Renamed native session",
      sessionModelRevision: initialRevision,
    });
    const initialReads = ownershipReads;
    const source = projection.capture({ agentId: "main", key })?.runtimeOwnershipDependencies?.[0]
      ?.identity;
    expect(source).toBeDefined();
    const pending = beginPluginStatePublication(() => source!);
    try {
      await projection.ensureMaterialized();
      expect(snapshot()?.model).toBe("gpt-5.6-sol");
      expect(ownershipReads).toBe(initialReads);
    } finally {
      pending.finish("completed");
    }
    await bindings.register("unrelated", "gpt-5.6-luna");
    await projection.ensureMaterialized();
    expect(ownershipReads).toBe(initialReads);
    expect(snapshot()?.sessionModelRevision).toBe(initialRevision);
    const saved = projection.capture({ agentId: "main", key })?.entry;
    await bindings.register(key, "gpt-5.6-luna");
    await projection.ensureMaterialized();
    expect(snapshot()).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-luna" });
    const changedRevision = snapshot()?.sessionModelRevision;
    expect(changedRevision).toEqual(expect.any(String));
    expect(changedRevision).not.toBe(initialRevision);
    expect(projection.capture({ agentId: "main", key })?.entry).toEqual(saved);
    await bindings.delete(key);
    await projection.ensureMaterialized();
    expect(snapshot()).toMatchObject({ modelProvider: "openai", model: "gpt-5.5" });
    const removedRevision = snapshot()?.sessionModelRevision;
    expect(removedRevision).toEqual(expect.any(String));
    expect(removedRevision).not.toBe(changedRevision);
    const beforeUnknown = ownershipReads;
    beginPluginStatePublication(() => source!).finish("unknown");
    await projection.ensureMaterialized();
    expect(ownershipReads).toBeGreaterThan(beforeUnknown);
    expect(snapshot()?.model).toBe("gpt-5.5");
    expect(snapshot()?.sessionModelRevision).toBe(removedRevision);
    expect(syncOwnership).not.toHaveBeenCalled();
  });
});

it.for([100, 1_000, 8_000])(
  "measures unrelated plugin publication with %i native session rows",
  async (rowCount) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const preparationStarted = performance.now();
      const bindings = createPluginStateKeyedStoreV2<string>(
        "row-native",
        { namespace: "publication-latency", maxEntries: 10 },
        { assertCurrent() {} },
      );
      await bindings.register("shared-model", "synthetic-model");
      const keys = Array.from(
        { length: rowCount },
        (_, index) => `agent:main:harness:row-native:publication-${index}`,
      );
      for (const [index, key] of keys.entries()) {
        seedNative(key, `publication-${index}`, { visibility: "shared" });
      }
      let ownershipReads = 0;
      using _native = nativeHarness(async () => {
        ownershipReads++;
        const model = await bindings.lookup("shared-model");
        return model
          ? { model: "native", auth: "native", modelRef: { provider: "example", model } }
          : undefined;
      });
      using _foreground = holdForeground();
      const unrelatedKey = pluginStatePublicationKey({
        plugin_id: "row-native",
        namespace: "publication-latency",
        entry_key: "unrelated",
      });
      const subscriptions: Array<{ active: boolean }> = [];
      const callbackSamples: Array<{ wallMs: number; cpuMs: number }> = [];
      const subscribe = pluginStatePublication.subscribeFacts;
      let measuring = false;
      using _subscriptions = vi
        .spyOn(pluginStatePublication, "subscribeFacts")
        .mockImplementation((listener) => {
          const subscription = { active: true };
          subscriptions.push(subscription);
          const stop = subscribe((change) => {
            if (
              !measuring ||
              change.kind !== "committed" ||
              !change.receipt.facts.has(unrelatedKey)
            ) {
              listener(change);
              return;
            }
            const cpu = process.threadCpuUsage();
            const started = performance.now();
            try {
              listener(change);
            } finally {
              const wallMs = performance.now() - started;
              const used = process.threadCpuUsage(cpu);
              callbackSamples.push({ wallMs, cpuMs: (used.user + used.system) / 1_000 });
            }
          });
          return () => {
            subscription.active = false;
            stop();
          };
        });
      using projection = await createTestProjection({ cfg: defaultConfig, modelCatalog: [] });
      await projection.ensureMaterialized();
      expect(subscriptions.filter((subscription) => subscription.active)).toHaveLength(1);
      _subscriptions.mockRestore();
      expect(ownershipReads).toBe(rowCount);
      expect(
        keys.every((key) =>
          projection
            .capture({ agentId: "main", key })
            ?.runtimeOwnershipDependencies?.some(
              (dependency) =>
                dependency.pluginId === "row-native" &&
                dependency.namespace === "publication-latency" &&
                dependency.keys.includes("shared-model"),
            ),
        ),
      ).toBe(true);
      const preparationMs = performance.now() - preparationStarted;
      const context = bindSessionRowProjection(requestContext(defaultConfig), () => projection);
      const list = async () => {
        const respond = vi.fn();
        const started = performance.now();
        await sessionReadHandlers["sessions.list"]!({
          req: { type: "req", id: "publication-latency", method: "sessions.list" },
          params: { agentId: "main", limit: 100, includeLastMessage: false },
          client: null,
          context,
          isWebchatConnect: () => false,
          respond,
        });
        const elapsed = performance.now() - started;
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ totalCount: rowCount }),
        );
        const result: unknown = respond.mock.calls[0]?.[1];
        if (!isRecord(result) || !Array.isArray(result.sessions)) {
          throw new Error("Synthetic list response is missing its session rows");
        }
        expect(result.sessions).toHaveLength(Math.min(100, rowCount));
        const rows = result.sessions.map((row: unknown) => {
          if (!isRecord(row)) {
            throw new Error("Synthetic list response contains an invalid row");
          }
          expect(row).toMatchObject({
            model: "synthetic-model",
            sessionModelRevision: expect.any(String),
          });
          return { key: row.key, model: row.model, sessionModelRevision: row.sessionModelRevision };
        });
        return { elapsed, rows };
      };
      const initial = await list();
      for (let warmup = 0; warmup < 5; warmup++) {
        await bindings.register("unrelated", `warm-${warmup}`);
      }
      const materializedCount = projection.materializedCount;
      const revision = projection.snapshot({ agentId: "main", key: keys[0]! }).row
        ?.sessionModelRevision;
      expect(revision).toEqual(expect.any(String));
      const postPublicationRequestMs: number[] = [];
      measuring = true;
      for (let sample = 0; sample < 32; sample++) {
        await bindings.register("unrelated", `sample-${sample}`);
        const response = await list();
        expect(response.rows).toEqual(initial.rows);
        postPublicationRequestMs.push(response.elapsed);
      }
      measuring = false;
      expect(callbackSamples).toHaveLength(32);
      expect(ownershipReads).toBe(rowCount);
      expect(projection.materializedCount).toBe(materializedCount);
      expect(
        projection.snapshot({ agentId: "main", key: keys[0]! }).row?.sessionModelRevision,
      ).toBe(revision);
      const summarize = (values: number[]) => {
        const sorted = values.toSorted((a, b) => a - b);
        return {
          median: sorted[Math.ceil(sorted.length / 2) - 1],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          min: sorted[0],
          max: sorted.at(-1),
        };
      };
      console.log(
        JSON.stringify({
          diagnostic: "session-unrelated-plugin-publication",
          rows: rowCount,
          samples: callbackSamples.length,
          preparationMs,
          ownershipReads,
          callbackWallMs: summarize(callbackSamples.map((sample) => sample.wallMs)),
          callbackCpuMs: summarize(callbackSamples.map((sample) => sample.cpuMs)),
          postPublicationRequestMs: summarize(postPublicationRequestMs),
        }),
      );
    });
  },
);
