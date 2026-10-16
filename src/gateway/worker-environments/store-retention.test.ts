import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createEnvironmentStoreFixture } from "./placement-test-fixtures.js";
import {
  createWorkerEnvironmentStore,
  type WorkerEnvironmentRecord,
  type WorkerEnvironmentStore,
} from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PRUNE_NOW_MS = 10 * DAY_MS;

const admission = vi.hoisted(() => ({ beforeCommit: undefined as (() => void) | undefined }));
vi.mock("../../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      admit: Parameters<typeof actual.createSqliteWorkerOperationAdmission>[0],
      attachment?: Parameters<typeof actual.createSqliteWorkerOperationAdmission>[1],
    ) =>
      actual.createSqliteWorkerOperationAdmission((request, grant) => {
        if (request.stage === "commit") {
          admission.beforeCommit?.();
        }
        admit(request, grant);
      }, attachment),
  };
});

describe("worker environment terminal retention", () => {
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let nowMs: number;
  const { fallbackPortRows, seedBootstrapping, readyPatch } = createEnvironmentStoreFixture({
    getStore: () => store,
    getDatabase: () => database,
    now: () => nowMs,
  });
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      admission.beforeCommit = undefined;
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );

  beforeEach(async () => {
    const root = tempDirs.make("openclaw-worker-env-retention-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
  });

  async function seedOrphaned(environmentId: string, stateChangedAtMs: number) {
    nowMs = 1_000;
    const bootstrapping = await seedBootstrapping(environmentId, `lease:${environmentId}`);
    await store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: readyPatch(),
    });
    nowMs = stateChangedAtMs;
    return store.transition({ environmentId, from: "ready", to: "orphaned" });
  }

  it("prunes only old unreferenced terminal environments and cascades owned rows", async () => {
    await seedOrphaned("worker-old-first", DAY_MS);
    await seedOrphaned("worker-a-old-second", 2 * DAY_MS);
    await seedOrphaned("worker-referenced", 3 * DAY_MS);
    await seedOrphaned("worker-recent", PRUNE_NOW_MS - 1_000);
    nowMs = 1_000;
    const ready = await seedBootstrapping("worker-ready", "lease:worker-ready");
    await store.transition({
      environmentId: ready.environmentId,
      from: ready.state,
      to: "ready",
      patch: readyPatch(),
    });
    database.db
      .prepare(
        `INSERT INTO worker_session_placements (
          session_id, agent_id, session_key, state, environment_id, recovery_error,
          created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES ('session-referenced', 'agent-1', 'session-key-1', 'failed', ?,
          'worker environment disappeared', 1, 1, 1)`,
      )
      .run("worker-referenced");
    database.db
      .prepare(
        `INSERT INTO worker_inference_turns (
          session_id, run_epoch, run_id, turn_id, environment_id, request_hash,
          state, terminal_json, created_at_ms, updated_at_ms
        ) VALUES ('session-old', 1, 'run-old', 'turn-old', ?, 'hash-old',
          'terminal', '{}', 1, 1)`,
      )
      .run("worker-old-first");
    expect(fallbackPortRows("worker-old-first")).toHaveLength(2);

    const canPruneDemand = () => true;
    expect(
      await store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS, limit: 1, canPruneDemand }),
    ).toBe(1);
    expect(store.get("worker-old-first")).toBeUndefined();
    expect(fallbackPortRows("worker-old-first")).toEqual([]);
    expect(
      database.db
        .prepare("SELECT environment_id FROM worker_inference_turns WHERE environment_id = ?")
        .get("worker-old-first"),
    ).toBeUndefined();

    expect(
      await store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS, limit: 10, canPruneDemand }),
    ).toBe(1);
    expect(store.get("worker-a-old-second")).toBeUndefined();
    expect(store.get("worker-referenced")?.state).toBe("orphaned");
    expect(store.get("worker-recent")?.state).toBe("orphaned");
    expect(store.get("worker-ready")?.state).toBe("ready");
  });

  it.each(["demand", "placement"] as const)(
    "continues past a page retained by %s",
    async (retainedBy) => {
      await seedOrphaned("worker-0000", DAY_MS);
      const template = database.db.prepare("SELECT * FROM worker_environments").get()!;
      const columns = Object.keys(template);
      const insert = database.db.prepare(
        `INSERT INTO worker_environments (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      );
      runOpenClawStateWriteTransaction(
        () => {
          for (let index = 1; index <= 256; index += 1) {
            const suffix = String(index).padStart(4, "0");
            const row = {
              ...template,
              environment_id: `worker-${suffix}`,
              provision_operation_id: `provision-${suffix}`,
              lease_id: `lease:worker-${suffix}`,
            };
            insert.run(...columns.map((column) => row[column as keyof typeof row]));
          }
          if (retainedBy === "placement") {
            const reference = database.db.prepare(
              `INSERT INTO worker_session_placements (
              session_id, agent_id, session_key, state, environment_id, recovery_error,
              created_at_ms, updated_at_ms, state_changed_at_ms
            ) VALUES (?, 'agent-1', ?, 'failed', ?, 'worker environment disappeared', 1, 1, 1)`,
            );
            for (let index = 0; index < 256; index += 1) {
              const id = `worker-${String(index).padStart(4, "0")}`;
              reference.run(`session-${index}`, `session-key-${index}`, id);
            }
          }
        },
        { database },
      );
      // Raw fixture writes precede hydration, just like an ordinary restart.
      await store.close();
      store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
      expect(
        await store.pruneTerminalEnvironments({
          nowMs: PRUNE_NOW_MS,
          limit: 1,
          canPruneDemand: (record) => {
            return retainedBy === "placement" || record.environmentId === "worker-0256";
          },
        }),
      ).toBe(1);
      expect(store.get("worker-0256")).toBeUndefined();
      expect(store.get("worker-0000")?.state).toBe("orphaned");
      expect(
        database.db.prepare("SELECT count(*) AS count FROM worker_environments").get(),
      ).toEqual({
        count: 256,
      });
    },
  );

  it("defers the batch when live demand changes at worker commit and preserves policy errors", async () => {
    await seedOrphaned("worker-retention-first", DAY_MS);
    await seedOrphaned("worker-retention-protected", 2 * DAY_MS);
    const readRows = () =>
      database.db.prepare("SELECT * FROM worker_environments ORDER BY environment_id").all();
    const before = readRows();
    let protectedDemand = false;
    let predicateError: Error | undefined;
    const canPruneDemand = (record: WorkerEnvironmentRecord) => {
      if (predicateError) {
        throw predicateError;
      }
      return !protectedDemand || record.environmentId !== "worker-retention-protected";
    };
    const prune = () =>
      store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS, limit: 2, canPruneDemand });
    admission.beforeCommit = () => {
      protectedDemand = true;
    };
    expect(await prune()).toBe(0);
    expect(protectedDemand).toBe(true);
    expect(readRows()).toEqual(before);
    expect(store.list().map((record) => record.environmentId)).toEqual([
      "worker-retention-first",
      "worker-retention-protected",
    ]);

    protectedDemand = false;
    const failure = new Error("retention provider unavailable");
    admission.beforeCommit = () => {
      predicateError = failure;
    };
    await expect(prune()).rejects.toBe(failure);
    expect(readRows()).toEqual(before);

    admission.beforeCommit = undefined;
    predicateError = undefined;
    expect(await prune()).toBe(2);
    expect(store.list()).toEqual([]);
  });
});
