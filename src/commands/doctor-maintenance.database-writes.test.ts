import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { restoreFailedUpdateDatabases } from "../cli/update-cli/update-command-database-backup.js";
import { recordUpdateDatabaseWrites } from "../cli/update-cli/update-command-database-receipts.js";
import { createUpdateDatabaseBackup } from "../infra/update-database-backup.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

it.each(["unchanged", "before-admission", "during-maintenance"] as const)(
  "checks current data at final restore without a Doctor receipt (%s)",
  async (change) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-final-restore" },
      async (state) => {
        openOpenClawStateDatabase();
        await closeOpenClawStateDatabaseAsync();
        const pathname = state.path("agent.sqlite");
        const seed = new DatabaseSync(pathname);
        try {
          seed.exec("CREATE TABLE evidence(value INTEGER); INSERT INTO evidence VALUES (1)");
        } finally {
          seed.close();
        }
        const backup = await createUpdateDatabaseBackup({
          backupRoot: state.path("retained-snapshots"),
          stateDir: state.stateDir,
          config: {},
          env: state.env,
          additionalPaths: [pathname],
          preserveSourceArtifacts: true,
        });
        expect(backup.databases.some((entry) => entry.path === pathname)).toBe(true);
        expect(backup.sourceGenerations[pathname]).toEqual(expect.any(String));
        const append = () => {
          // This writer deliberately does not participate in Gateway maintenance.
          const foreign = new DatabaseSync(pathname);
          try {
            foreign.exec("INSERT INTO evidence VALUES (99)");
          } finally {
            foreign.close();
          }
        };
        if (change === "before-admission") {
          append();
        }
        const maintenance = await beginDoctorMaintenance({
          root: null,
          options: { repair: true, nonInteractive: true },
          runtime: { log() {}, error() {}, exit() {} },
        });
        try {
          expect(maintenance).toBeDefined();
          if (change === "during-maintenance") {
            append();
          }
          await maintenance!.releaseState();
          recordUpdateDatabaseWrites(backup, undefined, {
            name: "doctor",
            command: "doctor --fix",
            cwd: state.stateDir,
            durationMs: 0,
            exitCode: 1,
          });
          const result: UpdateRunResult = {
            status: "error",
            mode: "npm",
            steps: [],
            durationMs: 0,
          };
          const restored = await restoreFailedUpdateDatabases({
            backup,
            result,
            runId: "final-restore",
            env: state.env,
            assertCurrent() {},
          });
          expect(restored).toBe(change === "unchanged");
          if (change !== "unchanged") {
            expect(result.reason).toBe("state-migrated-no-rollback");
            expect(backup.restoreRefusal).toContain(pathname);
          }
          const preserved = new DatabaseSync(pathname, { readOnly: true });
          try {
            expect(preserved.prepare("SELECT value FROM evidence ORDER BY value").all()).toEqual(
              change === "unchanged" ? [{ value: 1 }] : [{ value: 1 }, { value: 99 }],
            );
          } finally {
            preserved.close();
          }
        } finally {
          await maintenance?.release();
        }
      },
    );
  },
);
