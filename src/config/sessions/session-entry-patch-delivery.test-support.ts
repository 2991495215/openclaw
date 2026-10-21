import { afterEach, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";

// mock-isolation: Entry assertions exclude the maintenance owner's background writes and timers.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Disk-budget sweeps must not mutate the fixture outside its explicit entry writes.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

type Delivery = {
  afterPrepare?: () => void | Promise<void>;
  afterCommit?: () => void | Promise<void>;
  beforeCommit?: () => void | Promise<void>;
  commands: string[];
};

const scopedDeliveries = vi.hoisted(() => new Map<string, Delivery>());
const delivery = vi.hoisted(() => ({
  afterPrepare: undefined as (() => void | Promise<void>) | undefined,
  afterCommit: undefined as (() => void | Promise<void>) | undefined,
  beforeCommit: undefined as (() => void | Promise<void>) | undefined,
  commands: [] as string[],
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  const { resolveOpenClawAgentSqlitePath: resolveNativeSqlitePath } =
    await import("../../state/openclaw-agent-db.paths.js");
  const withDelivery = (
    database: OpenClawAgentDatabaseOptions,
    owner: ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution>,
  ): typeof owner => {
    const storePath = resolveNativeSqlitePath(database);
    return {
      ...owner,
      get fileIdentity() {
        return owner.fileIdentity;
      },
      runExisting: (source, operation, options) =>
        owner.runExisting(
          source,
          (worker) =>
            operation({
              execute: async (command, commandOptions) => {
                const target = scopedDeliveries.get(storePath) ?? delivery;
                target.commands.push(command.type);
                if (command.type === "session.entry.patch.commit") {
                  await target.beforeCommit?.();
                }
                const result = await worker.execute(command, commandOptions);
                if (command.type === "session.entry.patch.prepare") {
                  await target.afterPrepare?.();
                }
                if (command.type === "session.entry.patch.commit") {
                  await target.afterCommit?.();
                }
                return result;
              },
            }),
          options,
        ),
    };
  };
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ) => withDelivery(args[0], actual.captureOpenClawAgentDatabaseExecution(...args)),
    captureOpenClawAgentDatabasePreparationExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabasePreparationExecution>
    ) => withDelivery(args[0], actual.captureOpenClawAgentDatabasePreparationExecution(...args)),
  };
});

afterEach(() => {
  delivery.afterPrepare = undefined;
  delivery.afterCommit = undefined;
  delivery.beforeCommit = undefined;
  delivery.commands = [];
  scopedDeliveries.clear();
  vi.restoreAllMocks();
});

export function getSessionEntryPatchDelivery(options?: OpenClawAgentDatabaseOptions): Delivery {
  if (!options) {
    return delivery;
  }
  const storePath = resolveOpenClawAgentSqlitePath(options);
  let target = scopedDeliveries.get(storePath);
  if (!target) {
    target = { commands: [] };
    scopedDeliveries.set(storePath, target);
  }
  return target;
}

export function observeCommitAdmission() {
  let current: admission.SqliteWorkerOperationAdmission | undefined;
  const create = admission.createSqliteWorkerOperationAdmission;
  vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
    (callback, attachment) => {
      const owned = create((request, grant) => {
        if (request.stage === "commit") {
          current = owned;
        }
        callback(request, grant);
      }, attachment);
      return owned;
    },
  );
  return () => current;
}
