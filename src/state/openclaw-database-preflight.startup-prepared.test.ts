import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareGatewayStartupSessions } from "../gateway/server-startup-session-migration.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { recordLegacyMigrationReceipt } from "../infra/state-migrations.receipts.js";
import * as logging from "../logging/subsystem.js";
import { readAgentDatabaseAdmissionRefusal } from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db.js";
import * as schemaInspection from "./openclaw-agent-schema-inspection-worker.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function createFleet() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("preflight-startup-prepared-") };
  const agentIds = ["first", "second", "third"];
  const config: OpenClawConfig = {
    agents: {
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
      defaults: { systemAgent: { agentId: "first" } },
    },
  };
  const paths = agentIds.map((agentId) => openOpenClawAgentDatabase({ agentId, env }).path);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const pathname of paths) {
    const database = new (requireNodeSqlite().DatabaseSync)(pathname);
    try {
      database.exec("PRAGMA journal_mode=DELETE;");
    } finally {
      database.close();
    }
  }
  const onAgentInspection = vi.fn();
  return {
    config,
    env,
    paths,
    onAgentInspection,
    ready: () =>
      assertOpenClawDatabasesReady({
        env,
        config,
        operation: "gateway-startup",
        onAgentInspection,
      }),
    inspect: (signal?: AbortSignal) =>
      preflightOpenClawDatabaseSchemas({
        env,
        signal,
        reuseStartupSchemaPreparation: true,
        onAgentInspection,
      }),
  };
}

function withImmediateAdmission(run: Parameters<typeof withAgentDatabaseStartupAdmission>[0]) {
  return withAgentDatabaseStartupAdmission(run, { deferInspections: false });
}

it.each([
  { agentId: "openclaw", ownerId: "openclaw" },
  { agentId: "crestodian", ownerId: "crestodian" },
  { agentId: "worker", ownerId: "worker" },
  { agentId: "openclaw", ownerId: "foreign" },
])(
  "keeps a held old-schema $agentId store with owner $ownerId unavailable without blocking healthy startup",
  async ({ agentId, ownerId }) => {
    const fleet = databaseFixture(tempDirs.make("startup-held-schema-"));
    const config = agentConfig(["main", "worker"], "main");
    const healthyPath = fleet.agent("main").path;
    const heldPath = fleet.agent(agentId).path;
    // The shipped receipt can name reserved IDs even though reconstruction no longer does.
    runOpenClawStateWriteTransaction(
      ({ db, path: statePath }) =>
        recordLegacyMigrationReceipt(db, {
          sourceKey: "agent-deletion-journal-reconstruction",
          migrationKind: "agent-deletion-journal-reconstruction",
          sourcePath: statePath,
          targetTable: "agent_deletion_journal",
          sourceSha256: null,
          sourceSizeBytes: null,
          sourceRecordCount: null,
          runId: "held-startup-fixture",
          now: 1,
          reportJson: JSON.stringify({
            description:
              "Quarantined unusable agent deletion records; stores remain held for explicit recovery",
            held: [{ agentId, path: heldPath }],
          }),
        }),
      { env: fleet.env },
    );
    closeDatabases();
    execSql(
      heldPath,
      `PRAGMA user_version=${supportedVersions.agent - 1}; UPDATE schema_meta SET schema_version=${supportedVersions.agent - 1}, agent_id='${ownerId}' WHERE meta_key='primary';`,
    );
    const before = fs.readFileSync(heldPath);
    const log = { info: vi.fn(), warn: vi.fn() };
    const createLogger = logging.createSubsystemLogger;
    vi.spyOn(logging, "createSubsystemLogger").mockImplementation((subsystem) => ({
      ...createLogger(subsystem),
      warn: log.warn,
    }));
    await withImmediateAdmission(async () => {
      await expect(fleet.ready(config)).resolves.toBeUndefined();
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env: fleet.env })).toMatchObject({
        code: "agent-database-inspection-failed",
        paths: [heldPath],
        repairHint: expect.stringContaining("openclaw doctor --fix"),
      });
      const prepared = await prepareGatewayStartupSessions({ cfg: config, env: fleet.env, log });
      expect(prepared.map(({ database }) => database.path)).toEqual([healthyPath]);
      expect(() => fleet.agent(agentId)).toThrow("held for deletion recovery");
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`Agent ${agentId} database is held.*openclaw doctor --fix`)),
    );
    expect(fs.readFileSync(heldPath)).toEqual(before);
  },
);

it("still refuses an unmigrated reserved store without a recovery hold", async () => {
  const fleet = databaseFixture(tempDirs.make("startup-unheld-schema-"));
  const pathname = fleet.agent("openclaw").path;
  closeDatabases();
  execSql(pathname, `PRAGMA user_version=${supportedVersions.agent - 1};`);
  await withImmediateAdmission(async () => {
    await expect(fleet.ready(agentConfig(["main"], "main"))).rejects.toThrow(
      `uses schema version ${supportedVersions.agent - 1}`,
    );
  });
});

it("skips an unowned non-reserved database across startup passes while keeping Doctor strict", async () => {
  const fleet = createFleet();
  const leftover = openOpenClawAgentDatabase({ agentId: "openclaw", env: fleet.env }).path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.writeFileSync(leftover, "not a configured database");
  const before = fs.readFileSync(leftover);
  await withAgentDatabaseStartupAdmission(async () => {
    await expect(fleet.ready()).resolves.toBeUndefined();
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
      expect.objectContaining({ schemaInspectionCount: fleet.paths.length }),
    );
    await expect(
      preflightOpenClawDatabaseSchemas({
        env: fleet.env,
        agentAdmissionConfig: fleet.config,
        reuseStartupSchemaPreparation: true,
        onAgentInspection: fleet.onAgentInspection,
      }),
    ).resolves.toEqual({ incompatible: [], indeterminate: [] });
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith({
      schemaInspectionCount: 0,
      schemaProcessCount: 0,
      schemaSnapshotCount: 0,
    });
    expect(readAgentDatabaseAdmissionRefusal("openclaw", { env: fleet.env })).toBeUndefined();
  });
  await expect(
    assertOpenClawDatabasesReady({
      env: fleet.env,
      config: fleet.config,
      operation: "doctor",
      configuredAgentDatabaseTargets: [],
    }),
  ).rejects.toThrow();
  expect(fs.readFileSync(leftover)).toEqual(before);
});

it.each(["historical", "retired shared"] as const)(
  "does not activate %s database owners",
  async (kind) => {
    const fleet = createFleet();
    const historyPath = path.join(
      fleet.env.OPENCLAW_STATE_DIR,
      "rollback-drill",
      "openclaw-agent.sqlite",
    );
    const agentId = kind === "retired shared" ? "retired" : "first";
    if (kind === "retired shared") {
      fleet.config.session = { store: historyPath };
    }
    openOpenClawAgentDatabase({ agentId, path: historyPath, env: fleet.env });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    clearOpenClawAgentIntegrityVerification(historyPath, fleet.env);
    const history = new (requireNodeSqlite().DatabaseSync)(historyPath);
    try {
      history.exec("PRAGMA journal_mode=DELETE;");
    } finally {
      history.close();
    }
    await withAgentDatabaseStartupAdmission(async () => {
      await fleet.ready();
      expect(readAgentDatabaseAdmissionRefusal("first", { env: fleet.env })).toBeUndefined();
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env: fleet.env })).toBeUndefined();
    });
  },
);

it("isolates an unreadable configured path while inspecting healthy agents", async () => {
  const fleet = createFleet();
  fleet.config.agents!.entries = { broken: {}, ...fleet.config.agents!.entries };
  fs.writeFileSync(path.join(fleet.env.OPENCLAW_STATE_DIR, "agents", "broken"), "not a directory");
  await withAgentDatabaseStartupAdmission(async () => {
    await fleet.ready();
    expect(readAgentDatabaseAdmissionRefusal("first", { env: fleet.env })).toBeUndefined();
    expect(readAgentDatabaseAdmissionRefusal("broken", { env: fleet.env })).toMatchObject({
      code: "agent-database-inspection-failed",
      reason: expect.stringMatching(/ENOTDIR|not a directory/i),
    });
  });
});

it("keeps pending startup stores fenced without inspecting or copying them again in bootstrap", async () => {
  const fleet = createFleet();
  const pathname = fleet.paths[0]!;
  const raw = new (requireNodeSqlite().DatabaseSync)(pathname);
  raw.exec("PRAGMA journal_mode=WAL;");
  raw.close();
  const entered = createDeferred();
  const release = createDeferred();
  const createReader = schemaInspection.createAgentSchemaInspectionWorker;
  let paused = false;
  let selectedInspections = 0;
  vi.spyOn(schemaInspection, "createAgentSchemaInspectionWorker").mockImplementation(() => {
    const reader = createReader();
    const inspect = reader.inspect;
    return Object.assign(reader, {
      inspect: async (...args: Parameters<typeof inspect>) => {
        if (args[0].pathname === pathname) {
          selectedInspections += 1;
          if (!paused) {
            paused = true;
            entered.resolve();
            await release.promise;
          }
        }
        return inspect(...args);
      },
    });
  });
  const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation");
  await withAgentDatabaseStartupAdmission(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const readiness = fleet.ready();
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      await readiness;
      vi.useRealTimers();
      const refusal = readAgentDatabaseAdmissionRefusal("first", { env: fleet.env });
      expect(refusal?.code).toBe("agent-database-inspection-pending");
      expect(selectedInspections).toBe(1);

      const bootstrap = await fleet.inspect();
      expect(bootstrap.agentRefusals).toContain(refusal);
      expect(readAgentDatabaseAdmissionRefusal("first", { env: fleet.env })).toBe(refusal);
      expect(selectedInspections).toBe(1);
      expect(prepare.mock.calls.filter(([source]) => source === pathname)).toEqual([]);
    } finally {
      vi.useRealTimers();
      release.resolve();
      await Promise.allSettled([readiness]);
    }
  });
});

it("carries fleet compatibility once into bootstrap while readiness always inspects fresh", async () => {
  const fleet = createFleet();
  await withAgentDatabaseStartupAdmission(async () => {
    await fleet.ready();
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
      expect.objectContaining({ schemaInspectionCount: fleet.paths.length }),
    );
    // Migration admission before and under its lease must remain independent.
    await fleet.ready();
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
      expect.objectContaining({ schemaInspectionCount: fleet.paths.length }),
    );
    expect(await fleet.inspect()).toEqual({ incompatible: [], indeterminate: [] });
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith({
      schemaInspectionCount: 0,
      schemaProcessCount: 0,
      schemaSnapshotCount: 0,
    });
    await fleet.inspect();
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
      expect.objectContaining({ schemaInspectionCount: fleet.paths.length }),
    );
  });
  await fleet.inspect();
  expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
    expect.objectContaining({ schemaInspectionCount: fleet.paths.length }),
  );
});

it("preserves configured ownership when reusing an unchanged inspected database", async () => {
  const fleet = createFleet();
  await withAgentDatabaseStartupAdmission(async () => {
    await fleet.ready();
    const inspected = await preflightOpenClawDatabaseSchemas(
      {
        env: fleet.env,
        agentAdmissionConfig: {
          ...fleet.config,
          agents: {
            ...fleet.config.agents,
            entries: { ...fleet.config.agents?.entries, alias: {} },
          },
        },
        configuredAgentDatabaseTargets: [{ agentId: "alias", path: fleet.paths[0]! }],
        reuseStartupSchemaPreparation: true,
        onAgentInspection: fleet.onAgentInspection,
      },
      "runtime",
    );
    expect(inspected).toMatchObject({ incompatible: [], indeterminate: [] });
    expect(inspected.agentRefusals).toEqual([
      expect.objectContaining({
        agentId: "alias",
        embeddedOwnerId: "first",
        code: "agent-database-ownership-mismatch",
        paths: [fleet.paths[0]],
      }),
    ]);
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith({
      schemaInspectionCount: 0,
      schemaProcessCount: 0,
      schemaSnapshotCount: 0,
    });
  });
});

it.each(["WAL commit", "replacement", "new registration"] as const)(
  "inspects only changed fleet members after %s and still refuses their newer schema",
  async (change) => {
    const fleet = createFleet();
    let changedPath = fleet.paths[0]!;
    const writer =
      change === "WAL commit" ? new (requireNodeSqlite().DatabaseSync)(changedPath) : undefined;
    writer?.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    try {
      await withAgentDatabaseStartupAdmission(async () => {
        await fleet.ready();
        if (change === "WAL commit") {
          const originalMainBytes = fs.readFileSync(changedPath);
          writer!.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
          expect(fs.readFileSync(changedPath)).toEqual(originalMainBytes);
        } else {
          if (change === "new registration") {
            changedPath = openOpenClawAgentDatabase({ agentId: "newcomer", env: fleet.env }).path;
            closeOpenClawAgentDatabasesForTest();
            closeOpenClawStateDatabaseForTest();
          }
          const replacement = path.join(path.dirname(changedPath), "replacement.sqlite");
          const mutationPath = change === "replacement" ? replacement : changedPath;
          if (change === "replacement") {
            fs.copyFileSync(changedPath, replacement);
          }
          const database = new (requireNodeSqlite().DatabaseSync)(mutationPath);
          try {
            database.exec(
              `PRAGMA journal_mode=DELETE; PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`,
            );
          } finally {
            database.close();
          }
          if (change === "replacement") {
            fs.renameSync(replacement, changedPath);
          }
        }
        expect(await fleet.inspect()).toMatchObject({
          incompatible: [
            {
              kind: "agent",
              path: changedPath,
              foundVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
            },
          ],
          indeterminate: [],
        });
        expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
          expect.objectContaining({ schemaInspectionCount: 1 }),
        );
      });
    } finally {
      writer?.close();
    }
  },
);

it("does not let prepared compatibility bypass cancellation or survive startup retirement", async () => {
  const fleet = createFleet();
  await withAgentDatabaseStartupAdmission(async (admission) => {
    await fleet.ready();
    const controller = new AbortController();
    const cancellation = new Error("startup cancelled after fleet admission");
    controller.abort(cancellation);
    fleet.onAgentInspection.mockClear();
    await expect(fleet.inspect(controller.signal)).rejects.toBe(cancellation);
    expect(fleet.onAgentInspection).not.toHaveBeenCalled();
    await admission.stop();
    expect(await fleet.inspect()).toEqual({ incompatible: [], indeterminate: [] });
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
      expect.objectContaining({ schemaInspectionCount: fleet.paths.length }),
    );
  });
});
