import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as backupRunRecords from "../state/backup-run-records.js";
import { createSqliteWalHealth } from "./sqlite-wal-health.test-support.js";
import { buildStatusCommandReportLines } from "./status.command-report.js";
import { createStatusCommandReportDataParams } from "./status.test-support.js";

// mock-isolation: Keep database inspection in its own owner proof; these tests exercise report data.
vi.mock("./status-database-engines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status-database-engines.js")>()),
  resolveStatusDatabaseEngines: async () => ({ source: "admitted", stores: [] }),
}));

beforeEach(() => {
  vi.stubEnv("OPENCLAW_PROFILE", undefined);
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  {
    enabled: true,
    jobs: 2,
    nextWakeAtMs: null,
    expected: "scheduler enabled · 2 total jobs · no wake scheduled",
  },
  {
    enabled: false,
    jobs: 1,
    nextWakeAtMs: null,
    expected: "scheduler disabled · 1 total job · no wake scheduled",
  },
  {
    enabled: true,
    jobs: 3,
    nextWakeAtMs: Date.parse("2026-09-01T12:00:00.000Z"),
    expected: "scheduler enabled · 3 total jobs · next wake 2026-09-01T12:00:00.000Z",
  },
])("reports scheduler status: $expected", async ({ enabled, jobs, nextWakeAtMs, expected }) => {
  const lines = await buildStatusCommandReportLines(
    createStatusCommandReportDataParams({
      automations: { ok: true, value: { enabled, jobs, nextWakeAtMs } },
    }),
  );
  const output = stripAnsi(lines.join("\n"));
  expect(output).toContain(expected);
  expect(output).not.toContain("Heartbeat");
});

it("awaits backup freshness before assembling the overview", async () => {
  const freshness = createDeferred<backupRunRecords.BackupRunFreshness>();
  vi.spyOn(backupRunRecords, "readBackupRunFreshness").mockReturnValueOnce(freshness.promise);
  const pending = buildStatusCommandReportLines(createStatusCommandReportDataParams());
  freshness.resolve({
    latest: {
      id: "failed-backup",
      createdAt: Date.now(),
      archivePath: "/backups/archive.tar.gz",
      status: "failed",
      kind: "archive",
    },
  });
  expect(stripAnsi((await pending).join("\n"))).toContain("last attempt failed just now (archive)");
});

it.each([
  {
    name: "plain error",
    error: "gateway still starting; phase plugins",
    expected: "unavailable (gateway still starting; phase plugins)",
  },
  {
    name: "terminal controls in gateway error",
    error:
      "gateway still starting; phase \u001b[31mplugins\u001b[0m\u001b]52;c;ZmFrZQ==\u0007\nretry",
    expected: "unavailable (gateway still starting; phase plugins\\nretry)",
  },
])("keeps startup guidance for $name", async ({ error, expected }) => {
  const params = createStatusCommandReportDataParams();
  const lines = await buildStatusCommandReportLines({
    ...params,
    surface: {
      ...params.surface,
      gatewayReachable: false,
      gatewayProbe: { startupPhase: "plugins", error: null },
    },
    health: undefined,
    automations: { ok: false, error },
  });
  expect(stripAnsi(lines.join("\n"))).toContain(expected);
  expect(lines.at(-1)).toBe("  Retry after startup: openclaw status --deep");
  expect(lines.join("\n")).not.toContain("Fix reachability first");
});

it("shows skipped audit text when fast status omits the security audit", async () => {
  const lines = await buildStatusCommandReportLines(
    createStatusCommandReportDataParams({ securityAudit: undefined }),
  );
  expect(stripAnsi(lines.join("\n"))).toContain(
    "Skipped in fast status. Full report: openclaw security audit\nDeep check: openclaw status --deep",
  );
});

it("renders the recorded SQLite checkpoint warning in deep status", async () => {
  const params = createStatusCommandReportDataParams();
  const sqliteWal = createSqliteWalHealth({
    state: "blocked",
    warning: true,
    consecutiveBlocked: 2,
    observedAtMs: Date.parse("2026-09-13T12:00:00.000Z"),
    walBytes: 128 * 1024 * 1024,
    checkpointedFrames: 100,
    lastCompletedAtMs: Date.parse("2026-09-13T11:00:00.000Z"),
  });
  const lines = await buildStatusCommandReportLines({
    ...params,
    summary: { ...params.summary, sqliteWal },
    opts: { deep: true },
    tableWidth: 500,
  });
  const output = stripAnsi(lines.join("\n"));
  expect(output).toMatch(/SQLite WAL[^\n]*WARN/);
  expect(output).toContain("checkpoint blocked");
  expect(output).toContain("WAL 128.0 MiB");
  expect(output).toContain("frames 100/4000 checkpointed");
  expect(output).toContain("last complete 2026-09-13T11:00:00.000Z");
  expect(output).toContain("observed 2026-09-13T12:00:00.000Z");
  expect(output).toContain("openclaw gateway restart");
});
