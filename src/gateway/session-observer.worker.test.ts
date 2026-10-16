import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { targetDiscoveryLane } from "../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { SessionObserverDeps } from "./session-observer-model.js";
import * as observerWork from "./session-observer-work.js";
import { createSessionObserver } from "./session-observer.js";
import {
  createHarness,
  event,
  modelMessage,
  preparedModel,
  resetSessionObserverEventSequence,
} from "./session-observer.test-utils.js";
import { notifyGatewaySessionReset } from "./session-reset-notifications.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

const key = "agent:main:session-1";

function interceptNextProjectionRead(
  projection: SessionRowProjection,
  beforeRead: () => void | Promise<void>,
) {
  const read = projection.withPreparedExactRows.bind(projection);
  const intercepted = vi.fn(beforeRead);
  vi.spyOn(projection, "withPreparedExactRows").mockImplementationOnce(
    async (queries, consume, options) => {
      await intercepted();
      return read(queries, consume, options);
    },
  );
  return intercepted;
}

async function withObserver(
  run: (fixture: {
    observer: ReturnType<typeof createSessionObserver>;
    broadcast: ReturnType<typeof vi.fn>;
    persisted: ReturnType<typeof vi.fn>;
    projection: SessionRowProjection;
    peer: DatabaseSync;
    storePath: string;
    replaceStore: () => Promise<void>;
    rewriteLifecycle: () => void;
    resetLifecycle: () => Promise<void>;
    closeDatabase: () => ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync>;
    advanceClock: () => void;
    watch: (enabled: boolean) => void;
    enableModel: () => void;
  }) => Promise<void>,
  persistDigests = false,
  useDefaultStore = false,
) {
  await withOpenClawTestState({ label: "observer-worker" }, async ({ env, path }) => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env,
      ...(useDefaultStore ? {} : { path: path("original.sqlite") }),
    });
    writeSessionEntry(database, key, {
      sessionId: "session-id",
      lifecycleRevision: "life-a",
      updatedAt: 1,
    });
    const peer = new DatabaseSync(database.path);
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe("viewer", key)?.commit();
    const broadcast = vi.fn();
    const persisted = vi.fn<NonNullable<SessionObserverDeps["persistDigest"]>>(async () => true);
    let utilityModelRef: string | undefined;
    let now = 1_000;
    const cfg = {
      session: { store: useDefaultStore ? undefined : database.path },
      agents: { entries: { main: {} } },
    };
    setRuntimeConfigSnapshot(cfg);
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => cfg,
      modelCatalog: [],
    });
    await projection.withPreparedExactRows(
      () => [{ key, agentId: "main" }],
      () => undefined,
    );
    const observer = createSessionObserver({
      getConfig: () => cfg,
      getSessionRowProjection: () => projection,
      now: () => now,
      subscribers,
      broadcastToConnIds: broadcast,
      ...(persistDigests ? {} : { persistDigest: persisted }),
      resolveUtilityModelRef: () => utilityModelRef,
      prepareModel: async () => preparedModel(),
      completeModel: async () =>
        modelMessage({ headline: "Completed observation", health: "done" }),
    });
    observer.setConnectionVisibility("viewer", true);
    try {
      await run({
        observer,
        broadcast,
        persisted,
        projection,
        peer,
        storePath: database.path,
        rewriteLifecycle: () => {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: key, storePath: database.path, env },
            {
              sessionId: "session-id",
              lifecycleRevision: "life-b",
              updatedAt: 2,
            },
          );
        },
        resetLifecycle: async () => {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: key, storePath: database.path, env },
            { sessionId: "session-id", lifecycleRevision: "life-b", updatedAt: 2 },
          );
        },
        closeDatabase: () => {
          projection.dispose();
          return closeOpenClawAgentDatabaseByPathAsync(database.path);
        },
        advanceClock: () => {
          now += 2_000;
        },
        enableModel: () => {
          utilityModelRef = "openai/gpt-test";
        },
        watch: (enabled) => {
          if (enabled) {
            subscribers.subscribe("viewer", key)?.commit();
          } else {
            subscribers.unsubscribe("viewer", key);
          }
        },
        replaceStore: async () => {
          const storePath = path("replacement.sqlite");
          unregisterOpenClawAgentDatabase({ agentId: "main", path: database.path, env });
          cfg.session.store = storePath;
          setRuntimeConfigSnapshot(cfg);
          await replaceSessionEntry(
            { agentId: "main", sessionKey: key, storePath, env },
            {
              sessionId: "session-id",
              lifecycleRevision: "life-a",
              updatedAt: 1,
            },
          );
          await projection.withPreparedExactRows(
            () => [{ key, agentId: "main" }],
            (read) => {
              expect(read.describe({ key, agentId: "main" })?.storeTarget.storePath).toBe(
                storePath,
              );
            },
          );
        },
      });
    } finally {
      await observer.disposeAsync();
      projection.dispose();
      peer.close();
      vi.restoreAllMocks();
    }
  });
}

it("reuses ready observer facts without store discovery and observes committed resets", async () => {
  await withObserver(
    async ({ observer, broadcast, resetLifecycle }) => {
      const start = event({ stream: "lifecycle", data: { phase: "start" } });
      let inventories = 0;
      let entries = 0;
      const run = targetDiscoveryLane.pool.run.bind(targetDiscoveryLane.pool);
      vi.spyOn(targetDiscoveryLane.pool, "run").mockImplementation(async (...args) => {
        const result = await run(...args);
        if (
          result.ok &&
          typeof result.value === "object" &&
          result.value !== null &&
          "kind" in result.value
        ) {
          inventories += Number(result.value.kind === "session-target-inventory");
          entries += Number(result.value.kind === "session-exact-entries");
        }
        return result;
      });
      const sql = observeMainThreadSql();
      try {
        observer.handleEvent(start);
        sql.expectIdle();
        sql.clear();
        await observer.handleEventAsync({ ...start, runId: "worker-run" });
        expect(inventories).toBe(0);
        inventories = 0;
        entries = 0;
        await observer.handleEventAsync(
          event({
            runId: "worker-run",
            stream: "item",
            data: { kind: "preamble", progressText: "Worker observation" },
          }),
        );
        expect(inventories).toBe(0);
        expect(entries).toBe(0);
        const snapshot = await observer.getCompanionSnapshotAsync(key, "main");
        expect(snapshot.digest?.headline).toBe("Worker observation");
        sql.expectIdle();
        sql.restore();
        await resetLifecycle();
        const after = observeMainThreadSql();
        try {
          expect((await observer.getCompanionSnapshotAsync(key, "main")).digest).toBeUndefined();
          await observer.handleEventAsync(
            event({ runId: "worker-run", stream: "lifecycle", data: { phase: "end" } }),
          );
          await observer.disposeAsync();
          expect(broadcast).toHaveBeenCalledTimes(1);
          after.expectIdle();
        } finally {
          after.restore();
        }
      } finally {
        sql.restore();
      }
    },
    false,
    true,
  );
});

it("persists observer digests through the private session owner and forgets reset lifecycles", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:dashboard:incognito-observer";
    const target = { agentId: "main", sessionKey };
    const entry = {
      sessionId: "private-observer",
      lifecycleRevision: "private-a",
      incognito: true as const,
      updatedAt: 1,
    };
    await replaceSessionEntry(target, entry);
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe("viewer", sessionKey)?.commit();
    const observer = createSessionObserver({
      getConfig: () => cfg,
      getSessionRowProjection: () => projection,
      subscribers,
      broadcastToConnIds: vi.fn(),
      resolveUtilityModelRef: () => undefined,
    });
    observer.setConnectionVisibility("viewer", true);
    const persisted = createDeferred();
    const unsubscribe = sessionChanges.subscribe((change) => {
      if (
        "sessionKey" in change &&
        change.sessionKey === sessionKey &&
        change.scope === "runtime"
      ) {
        persisted.resolve();
      }
    });
    try {
      await observer.handleEventAsync(
        event({
          sessionKey,
          stream: "item",
          data: { kind: "preamble", progressText: "Private observation" },
        }),
      );
      await withinTest(persisted.promise, signal);
      expect(loadSessionEntryReadOnly(target)?.observerDigest?.headline).toBe(
        "Private observation",
      );
      await replaceSessionEntry(target, { ...entry, lifecycleRevision: "private-b", updatedAt: 2 });
      expect((await observer.getCompanionSnapshotAsync(sessionKey, "main")).digest).toBeUndefined();
    } finally {
      unsubscribe();
      await observer.disposeAsync();
      projection.dispose();
    }
  });
});

it.for(["rewrite", "close"] as const)(
  "refuses a companion snapshot when its read owner changes before consumption (%s)",
  async (change) => {
    await withObserver(async ({ observer, projection, rewriteLifecycle, closeDatabase }) => {
      await observer.handleEventAsync(
        event({ stream: "item", data: { kind: "preamble", progressText: "Previous lifecycle" } }),
      );
      let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
      const intercepted = interceptNextProjectionRead(projection, () => {
        if (change === "rewrite") {
          rewriteLifecycle();
        } else {
          closing = closeDatabase();
        }
      });
      try {
        await expect(observer.getCompanionSnapshotAsync(key, "main")).rejects.toThrow(
          change === "close"
            ? "Session row projection is no longer active"
            : /changed|revoked|closed|current|admission/i,
        );
        expect(intercepted).toHaveBeenCalledOnce();
      } finally {
        await closing;
      }
    });
  },
);

it("keeps queued preambles and terminal events behind awaited start admission", async () => {
  await withObserver(async ({ observer, broadcast, persisted, projection }) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    interceptNextProjectionRead(projection, async () => {
      entered.resolve();
      await release.promise;
    });
    const start = observer.handleEventAsync(
      event({ stream: "lifecycle", data: { phase: "start" } }),
    );
    const preamble = observer.handleEventAsync(
      event({ stream: "item", data: { kind: "preamble", progressText: "Queued note" } }),
    );
    const terminal = observer.handleEventAsync(
      event({ stream: "lifecycle", data: { phase: "end" } }),
    );
    try {
      await entered.promise;
      expect(broadcast).not.toHaveBeenCalled();
      release.resolve();
      await Promise.all([start, preamble, terminal]);
      await observer.disposeAsync();
      expect(broadcast.mock.calls[0]?.[1]).toMatchObject({ headline: "Queued note" });
      expect(persisted.mock.calls.at(-1)?.[0]).toMatchObject({ digest: { health: "done" } });
      await expect(
        observer.handleEventAsync(event({ stream: "lifecycle", data: { phase: "start" } })),
      ).rejects.toThrow("closed");
    } finally {
      release.resolve();
      await Promise.allSettled([start, preamble, terminal]);
    }
  });
});

it("fences an already returned row immediately when reset notification arrives", async () => {
  await withObserver(async ({ observer, broadcast, projection, rewriteLifecycle }) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    interceptNextProjectionRead(projection, async () => {
      entered.resolve();
      await release.promise;
    });
    const old = observer.handleEventAsync(
      event({ stream: "item", data: { kind: "preamble", progressText: "Retired work" } }),
    );
    const refused = expect(old).rejects.toThrow(/source changed|lifecycle changed/);
    try {
      await entered.promise;
      rewriteLifecycle();
      notifyGatewaySessionReset(key, "main");
      release.resolve();
      await refused;
      await observer.handleEventAsync(
        event({
          runId: "successor",
          stream: "item",
          data: { kind: "preamble", progressText: "Current work" },
        }),
      );
      expect(broadcast.mock.calls.map((call) => call[1])).toEqual([
        expect.objectContaining({
          runId: "successor",
          headline: "Current work",
          lifecycleRevision: "life-b",
        }),
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([old]);
    }
  });
});

it("does not disclose a predecessor digest when the configured store changes with matching session identities", async () => {
  await withObserver(async ({ observer, replaceStore, advanceClock }) => {
    await observer.handleEventAsync(
      event({ stream: "item", data: { kind: "preamble", progressText: "Previous store" } }),
    );
    expect((await observer.getCompanionSnapshotAsync(key, "main")).digest?.headline).toBe(
      "Previous store",
    );
    await replaceStore();
    advanceClock();
    observer.handleEvent(
      event({
        stream: "item",
        data: { kind: "preamble", progressText: "Unowned source" },
      }),
    );
    expect(await observer.getCompanionSnapshotAsync(key, "main")).toEqual({
      agentId: "main",
      notes: [],
    });
  });
});

it("does not write a dormant predecessor digest into a replacement store", async () => {
  await withObserver(async ({ observer, watch, replaceStore, persisted }) => {
    await observer.handleEventAsync(
      event({ stream: "item", data: { kind: "preamble", progressText: "Predecessor work" } }),
    );
    expect(persisted).toHaveBeenCalledOnce();
    watch(false);
    await replaceStore();
    persisted.mockClear();
    await observer.handleEventAsync(event({ stream: "lifecycle", data: { phase: "end" } }));
    await observer.disposeAsync();
    expect(persisted).not.toHaveBeenCalled();
  });
});

it("joins the worker-backed persistence of a legacy event adapter", async () => {
  await withObserver(async ({ observer, peer }) => {
    observer.handleEvent(
      event({ stream: "item", data: { kind: "preamble", progressText: "Legacy admission" } }),
    );
    const disposal = observer.disposeAsync();
    const afterClose = event({
      stream: "item",
      data: { kind: "preamble", progressText: "Rejected after close" },
    });
    observer.handleEvent(afterClose);
    await expect(observer.handleEventAsync(afterClose)).rejects.toThrow(
      "Session observer is closed",
    );
    await disposal;
    expect(
      peer
        .prepare(
          "SELECT json_extract(entry_json, '$.observerDigest.headline') AS headline FROM session_nodes WHERE session_key = ?",
        )
        .get(key),
    ).toEqual({ headline: "Legacy admission" });
  }, true);
});

it("lets the publisher finish its nested write before persisting the background digest", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", path: state.path("sessions.sqlite"), env: state.env };
    const entered = createDeferred();
    const release = createDeferred();
    const order: string[] = [];
    let digestEntered = false;
    const persistDigest = vi.fn(() =>
      runOpenClawAgentWorkerWrite(options, async () => {
        digestEntered = true;
        entered.resolve();
        await release.promise;
        order.push("persisted");
        return true;
      }),
    );
    const harness = createHarness({
      config: {
        session: { store: options.path },
        gateway: { controlUi: { sessionObserver: true } },
      },
      utilityModelRef: null,
      persistDigest,
    });
    let successor: Promise<void> | undefined;
    let disposal: Promise<void> | undefined;
    try {
      await runOpenClawAgentWriteAdmission(options, async () => {
        harness.observer.handleEvent(
          event({ stream: "item", data: { kind: "preamble", progressText: "Reviewing" } }),
        );
        expect(persistDigest).toHaveBeenCalledOnce();
        expect(digestEntered).toBe(false);
        await runOpenClawAgentWorkerWrite(options, async () => {
          order.push("publisher");
        });
      });
      await withinTest(entered.promise, signal);
      successor = runOpenClawAgentWriteAdmission(options, () =>
        runOpenClawAgentWorkerWrite(options, async () => {
          order.push("successor");
        }),
      );
      disposal = harness.observer.disposeAsync().then(() => {
        order.push("disposed");
      });
      release.resolve();
      await withinTest(Promise.all([successor, disposal]), signal);
      expect(order.slice(0, 2)).toEqual(["publisher", "persisted"]);
      expect(order).toHaveLength(4);
    } finally {
      release.resolve();
      await Promise.allSettled([successor, disposal]);
      await harness.observer.disposeAsync();
      resetSessionObserverEventSequence();
    }
  });
});

it.for(["model", "failed model", "synthesized terminal"] as const)(
  "rechecks physical source authority before consuming a %s digest",
  async (kind, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config: OpenClawConfig = {
        session: { store: state.path("original.sqlite") },
        gateway: { controlUi: { sessionObserver: true } },
        agents: { defaults: { utilityModel: "openai/gpt-test" } },
      };
      const replacementStore = state.path("replacement.sqlite");
      let changeSourceOnRead = false;
      let sourceChanges = 0;
      let backgroundRegistrations = 0;
      let backgroundFinished = createDeferred();
      const backgroundSettlements: Promise<void>[] = [];
      const createWork = observerWork.createSessionObserverWork;
      const factory = vi
        .spyOn(observerWork, "createSessionObserverWork")
        .mockImplementation((params) => {
          const work = createWork(params);
          const withCurrent = work.withCurrent.bind(work);
          vi.spyOn(work, "withCurrent").mockImplementation((...args) => {
            if (changeSourceOnRead) {
              changeSourceOnRead = false;
              config.session = { store: replacementStore };
              sourceChanges += 1;
            }
            return withCurrent(...args);
          });
          const background = work.background.bind(work);
          vi.spyOn(work, "background").mockImplementation((run) => {
            backgroundRegistrations += 1;
            const finished = backgroundFinished;
            const settled = createDeferred();
            backgroundSettlements.push(settled.promise);
            background(async () => {
              try {
                return await run();
              } finally {
                finished.resolve();
                settled.resolve();
              }
            });
          });
          return work;
        });
      let harness: ReturnType<typeof createHarness> | undefined;
      try {
        harness = createHarness({
          config,
          utilityModelRef: kind === "synthesized terminal" ? null : "openai/gpt-test",
          readSession: vi.fn(() => ({
            sessionId: "session-id",
            lifecycleRevision: "owned",
            updatedAt: 1,
          })),
          prepareModel: vi.fn(async () => preparedModel()),
          completeModel: vi.fn(async () => {
            if (kind === "failed model") {
              throw new Error("model request failed");
            }
            return modelMessage({ headline: "Finished reviewing", health: "done" });
          }),
        });
        expect(factory).toHaveBeenCalledOnce();
        if (kind !== "synthesized terminal") {
          await withinTest(
            harness.observer.handleEventAsync(
              event({
                stream: "lifecycle",
                data: { phase: "start", startedAt: 0 },
              }),
            ),
            signal,
          );
          await withinTest(
            harness.observer.handleEventAsync(
              event({
                stream: "tool",
                data: { phase: "start", name: "read", args: { path: "example.ts" } },
              }),
            ),
            signal,
          );
        } else {
          await withinTest(
            harness.observer.handleEventAsync(
              event({
                stream: "item",
                data: { kind: "preamble", progressText: "Reviewing", startedAt: 0 },
              }),
            ),
            signal,
          );
          expect(backgroundRegistrations).toBe(1);
          await withinTest(backgroundFinished.promise, signal);
          expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
          expect(harness.persistDigest).toHaveBeenCalledOnce();
          harness.broadcastToConnIds.mockClear();
          harness.persistDigest.mockClear();
          backgroundFinished = createDeferred();
          backgroundRegistrations = 0;
        }
        expect(backgroundRegistrations).toBe(0);
        changeSourceOnRead = true;
        await withinTest(
          harness.observer.handleEventAsync(
            event({
              stream: "lifecycle",
              data: { phase: "end", startedAt: 0, endedAt: 31_000 },
            }),
          ),
          signal,
        );
        expect(backgroundRegistrations).toBeGreaterThan(0);
        await withinTest(backgroundFinished.promise, signal);
        await withinTest(Promise.all(backgroundSettlements), signal);

        expect(sourceChanges).toBe(1);
        expect(config.session?.store).toBe(replacementStore);
        expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
        if (kind !== "synthesized terminal") {
          expect(harness.completeModel).toHaveBeenCalledOnce();
          expect(harness.persistDigest).not.toHaveBeenCalled();
        } else {
          expect(harness.completeModel).not.toHaveBeenCalled();
          expect(harness.persistDigest).toHaveBeenCalledOnce();
          expect(harness.persistDigest.mock.calls[0]?.[0].digest).toMatchObject({ health: "done" });
        }
      } finally {
        try {
          await harness?.observer.disposeAsync();
        } finally {
          factory.mockRestore();
          vi.restoreAllMocks();
          resetSessionObserverEventSequence();
        }
      }
    });
  },
);
