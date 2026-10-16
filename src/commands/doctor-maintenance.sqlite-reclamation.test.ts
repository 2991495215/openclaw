import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDoctorMaintenanceState } from "./doctor-maintenance-state.js";

it("drains an admitted custom agent outside the state root without closing unrelated state", async () => {
  await withOpenClawTestState({ scenario: "external-service", layout: "split" }, async (state) => {
    const pathname = state.path("custom-agent", "openclaw-agent.sqlite");
    const seeded = openOpenClawAgentDatabase({ agentId: "main", path: pathname, env: state.env });
    await closeOpenClawAgentDatabaseByPathAsync(seeded.path, "main");
    await closeOpenClawStateDatabaseAsync();
    const db = openNodeSqliteDatabase(pathname);
    db.exec(
      "PRAGMA auto_vacuum=NONE; VACUUM; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('custom agent');",
    );
    db.close();
    expect(pathname.startsWith(`${state.stateDir}${path.sep}`)).toBe(false);

    const unrelatedEnv = { ...state.env, OPENCLAW_STATE_DIR: state.path("unrelated-state") };
    const unrelated = openOpenClawAgentDatabase({ agentId: "other", env: unrelatedEnv });
    const controller = new AbortController();
    const maintenance = await createDoctorMaintenanceState({
      params: {
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      },
      env: state.env,
      signal: controller.signal,
      deadline: () => undefined,
      assertReadCurrent() {},
      warn: vi.fn(),
    });
    try {
      await maintenance.acquire();
      // A bootstrap handle under the owner but outside its resources scope must
      // still settle. Root-filtered drainage alone cannot find this custom path.
      const held = maintenance.owner!.run(() =>
        openOpenClawAgentDatabase({
          agentId: "main",
          path: pathname,
          env: state.env,
        }),
      );
      expect(held.db.isOpen).toBe(true);
      await expect(
        maintenance.enableSqliteReclamation([
          {
            agentId: "main",
            path: pathname,
            realPath: fs.realpathSync(pathname),
            source: "configured",
          },
        ]),
      ).resolves.toEqual({ warnings: [] });
      expect(held.db.isOpen).toBe(false);
      expect(unrelated.db.isOpen).toBe(true);
      const observed = openNodeSqliteDatabase(pathname, { readOnly: true });
      try {
        expect(observed.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(2);
        expect(observed.prepare("SELECT value FROM retained").get()?.value).toBe("custom agent");
      } finally {
        observed.close();
      }
    } finally {
      await maintenance.release();
      await closeOpenClawAgentDatabaseByPathAsync(unrelated.path, "other");
    }
  });
});
