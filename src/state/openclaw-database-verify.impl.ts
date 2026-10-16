import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toStructuredErrorObject } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { parseSqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import type { SqliteIntegrityConfirmation } from "../infra/sqlite-integrity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  OpenClawDatabaseVerifyResult,
  OpenClawDatabaseVerifyTarget,
} from "./openclaw-database-verify.worker.js";

const log = createSubsystemLogger("state/database-verify");
const DATABASE_VERIFY_CHILD_ARG = "--openclaw-database-verify-child";

type DatabaseVerifyWorkerExit = { code: number | null; signal: NodeJS.Signals | null };
const workerLifecycles = new WeakMap<ChildProcess, ReturnType<typeof ownDatabaseVerifyWorker>>();

export type DatabaseVerifyWorkerLifetime = {
  onWorker?: (worker: ChildProcess | undefined) => void;
  assertCurrent?: () => void;
};

function ownDatabaseVerifyWorker(worker: ChildProcess) {
  let terminationRequested = false;
  const settled = new Promise<DatabaseVerifyWorkerExit>((resolve) => {
    let exit: DatabaseVerifyWorkerExit | undefined;
    let disconnected = !worker.connected;
    const finish = () => {
      if (!exit || !disconnected) {
        return;
      }
      worker.off("exit", onExit);
      worker.off("disconnect", onDisconnect);
      worker.off("close", onClose);
      resolve(exit);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exit = { code, signal };
      finish();
    };
    const onDisconnect = () => {
      disconnected = true;
      finish();
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      // Failed launches emit error then close without exit. Spawned children
      // need exit+disconnect because parent disconnect can suppress close.
      if (worker.pid === undefined) {
        exit = { code, signal };
        disconnected = true;
        finish();
      }
    };
    worker.once("exit", onExit);
    worker.once("disconnect", onDisconnect);
    worker.once("close", onClose);
  });
  const lifecycle = {
    settled,
    requestTermination: () => {
      if (
        terminationRequested ||
        worker.pid === undefined ||
        worker.exitCode !== null ||
        worker.signalCode !== null
      ) {
        return;
      }
      terminationRequested = true;
      let signalError: Error | undefined;
      const onSignalError = (error: Error) => {
        signalError = error;
      };
      worker.on("error", onSignalError);
      try {
        if (worker.kill()) {
          return;
        }
      } catch (error) {
        signalError = toStructuredErrorObject(error);
      } finally {
        worker.off("error", onSignalError);
      }
      log.error("database verification worker termination failed; waiting for native exit", {
        pid: worker.pid,
        error: signalError?.message ?? "signal was not delivered",
      });
    },
  };
  workerLifecycles.set(worker, lifecycle);
  return lifecycle;
}

export function runDatabaseVerifyWorker(
  targets: readonly OpenClawDatabaseVerifyTarget[],
  options: DatabaseVerifyWorkerLifetime & { workerUrl?: URL } = {},
): Promise<OpenClawDatabaseVerifyResult[]> {
  options.assertCurrent?.();
  const workerUrl =
    options.workerUrl ?? resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.databaseVerify);
  const execArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
  let worker: ChildProcess;
  try {
    // Closing a source reader can release the Gateway's process-owned SQLite
    // locks, so verification keeps its own process.
    worker = fork(fileURLToPath(workerUrl), [DATABASE_VERIFY_CHILD_ARG], {
      execArgv,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch (error) {
    return Promise.reject(toStructuredErrorObject(error));
  }
  // Capture the lifetime before publishing the child so stop joins this same boundary.
  const lifecycle = ownDatabaseVerifyWorker(worker);
  let result: OpenClawDatabaseVerifyResult[] | undefined;
  let failure: Error | undefined;
  let settled = false;
  const fail = (error: unknown) => {
    if (settled) {
      return;
    }
    // kill() can emit another error synchronously. Preserve the triggering failure.
    failure ??= toStructuredErrorObject(error);
    lifecycle.requestTermination();
  };
  // Result shapes belong to the bundled child; integrity confirmation remains below.
  const onMessage = (message: OpenClawDatabaseVerifyResult[]) => {
    result = message;
  };
  worker.once("message", onMessage);
  worker.on("error", fail);
  const completion = lifecycle.settled.then((exit) => {
    settled = true;
    worker.off("message", onMessage);
    worker.off("error", fail);
    options.onWorker?.(undefined);
    if (failure) {
      throw failure;
    }
    if (exit.code !== 0) {
      throw new Error(
        `database verification worker exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}`,
      );
    }
    if (!result) {
      throw new Error("database verification worker exited without results");
    }
    return result;
  });
  options.onWorker?.(worker);
  if (worker.pid !== undefined) {
    try {
      worker.send(targets, (error) => {
        if (error) {
          fail(error);
        }
      });
    } catch (error) {
      fail(error);
    }
  }
  return completion;
}

export async function terminateDatabaseVerifyWorker(worker: ChildProcess): Promise<void> {
  const lifecycle = workerLifecycles.get(worker);
  if (!lifecycle) {
    throw new Error("database verification worker is not owned by this verifier");
  }
  lifecycle.requestTermination();
  await lifecycle.settled;
}

/** The caller drains its owners; the child binds full confirmation to file generations. */
export async function confirmDatabaseVerifyWorker(
  target: Omit<OpenClawDatabaseVerifyTarget, "check" | "confirm">,
  lifetime: DatabaseVerifyWorkerLifetime = {},
): Promise<SqliteIntegrityConfirmation> {
  const [result] = await runDatabaseVerifyWorker(
    [{ ...target, check: "full", confirm: true }],
    lifetime,
  );
  lifetime.assertCurrent?.();
  if (!result || result.path !== target.path) {
    throw new Error("database verification worker returned no confirmation");
  }
  const generation = result.generation ? parseSqliteFileGeneration(result.generation) : undefined;
  if (result.ok && generation) {
    return { status: "healthy", generation };
  }
  const error = new Error(result.error ?? "database integrity confirmation was unbound");
  if (result.terminal && generation) {
    error.name = "SqliteIntegrityError";
    return { status: "failed", error, terminal: true, generation };
  }
  return { status: "failed", error, terminal: false };
}
