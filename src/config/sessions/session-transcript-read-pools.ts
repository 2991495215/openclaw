import {
  captureSqliteWorkerClosePolicy,
  ensureSqliteLibrarySelected,
} from "../../infra/bun-sqlite-library.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  UsageCostWorkerReplyError,
  type UsageCostWorkerInput,
  type UsageCostWorkerReply,
} from "../../infra/session-cost-usage-worker.types.js";
import { resolveWorkerPoolSize } from "../../infra/worker-pool-sizing.js";
import { createOwnedWorkerTaskPool, WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type {
  SessionHistoryWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);

export function createSessionTranscriptHistoryPool(
  maxWorkers = resolveWorkerPoolSize("singleton"),
  onRotationComplete?: () => void,
) {
  let canCloseNativeResources: boolean | undefined;
  const pool = createOwnedWorkerTaskPool<
    SessionHistoryWorkerInput,
    SessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>
  >(
    {
      workerUrl,
      workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
      maxWorkers,
      idleTimeoutMs: 0,
      burstIdleTimeoutMs: 30_000,
      onRotationComplete() {
        canCloseNativeResources = undefined;
        onRotationComplete?.();
      },
      prepareWorker: () => {
        ensureSqliteLibrarySelected();
        // Early workers stay conservative if native-close qualification was still pending.
        canCloseNativeResources =
          captureSqliteWorkerClosePolicy() && (canCloseNativeResources ?? true);
        return { options: {} };
      },
    },
    { databaseAccess: "read-only" },
  );
  return {
    ...pool,
    canCloseNativeResources: () => canCloseNativeResources === true,
  };
}

export function createUsageCostPool(kind: "read" | "refresh", onRotationComplete: () => void) {
  return new WorkerTaskPool<UsageCostWorkerInput, UsageCostWorkerReply>({
    workerUrl,
    workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
    // Usage host writes and reader cleanup use one native worker per lane.
    workerClass: kind === "refresh" ? "writer" : "singleton",
    // Host writes can wait for a writer-held shared-compute reader; neither usage lane may hold its permit.
    idleTimeoutMs: 0,
    onRotationComplete,
    prepareWorker: () => {
      ensureSqliteLibrarySelected();
      return { options: {} };
    },
    validateResult(reply) {
      if (!reply.ok) {
        throw new UsageCostWorkerReplyError(reply.error);
      }
    },
  });
}

export type SessionDatabaseWorkerLane = {
  name: string;
  pool: { rotate: () => Promise<void> };
  native: boolean;
  pending: number;
  idleTimer?: NodeJS.Timeout;
  rotation?: Promise<void>;
};
