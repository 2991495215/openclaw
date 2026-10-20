import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type {
  DB as StateDatabase,
  WorkerTranscriptCommitHeads,
  WorkerTranscriptCommits,
} from "../../state/openclaw-state-db.generated.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import {
  isWorkerTranscriptCommitOutcome,
  type WorkerTranscriptCommitInput,
  type WorkerTranscriptCommitOutcome,
  type WorkerTranscriptCommitBeginResult,
  type WorkerTranscriptCommitOperations,
} from "./transcript-commit-store.worker-contract.js";

type TranscriptCommitDb = Pick<
  StateDatabase,
  "worker_transcript_commit_heads" | "worker_transcript_commits"
>;
type HeadRow = Selectable<WorkerTranscriptCommitHeads>;
type CommitRow = Selectable<WorkerTranscriptCommits>;

type ExistingCommitResult = Extract<
  WorkerTranscriptCommitBeginResult,
  { kind: "recover" | "replay" | "rejected" }
>;

function parseOutcomeJson(value: string): WorkerTranscriptCommitOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Worker transcript commit cached outcome is invalid", { cause: error });
  }
  if (isWorkerTranscriptCommitOutcome(parsed)) {
    return parsed.ok ? { ok: true, result: parsed.result } : { ok: false, reason: parsed.reason };
  }
  throw new Error("Worker transcript commit cached outcome is invalid");
}

const query = (db: EngineConnection) => getNodeSqliteKysely<TranscriptCommitDb>(db);

function findHead(db: EngineConnection, input: WorkerTranscriptCommitInput): HeadRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_transcript_commit_heads")
      .selectAll()
      .where("session_id", "=", input.sessionId)
      .where("run_epoch", "=", input.runEpoch),
  );
}

function findCommit(
  db: EngineConnection,
  input: WorkerTranscriptCommitInput,
): CommitRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_transcript_commits")
      .selectAll()
      .where("session_id", "=", input.sessionId)
      .where("run_epoch", "=", input.runEpoch)
      .where("seq", "=", input.seq),
  );
}

function classifyExistingCommit(params: {
  head: HeadRow | undefined;
  commit: CommitRow | undefined;
  input: WorkerTranscriptCommitInput;
}): ExistingCommitResult | undefined {
  if (!params.commit) {
    return undefined;
  }
  if (!params.head) {
    throw new Error("Worker transcript commit row has no sequence head");
  }
  if (
    params.head.environment_id !== params.input.environmentId ||
    params.commit.request_hash !== params.input.requestHash
  ) {
    return { kind: "rejected", reason: "conflict" };
  }
  if (params.commit.state === "pending") {
    return { kind: "recover" };
  }
  if (params.commit.state === "terminal" && params.commit.result_json !== null) {
    return { kind: "replay", outcome: parseOutcomeJson(params.commit.result_json) };
  }
  throw new Error("Worker transcript commit row has invalid terminal state");
}

export const workerTranscriptCommitOperations = {
  "placementTranscript.begin": (
    input: WorkerTranscriptCommitOperations["placementTranscript.begin"]["input"],
    { writeAdmitted },
  ): WorkerTranscriptCommitBeginResult => {
    return writeAdmitted<WorkerTranscriptCommitBeginResult>(
      ({ db }) => {
        const head = findHead(db, input);
        const existing = classifyExistingCommit({ head, commit: findCommit(db, input), input });
        if (existing) {
          return existing;
        }
        if (head && head.environment_id !== input.environmentId) {
          return { kind: "rejected", reason: "conflict" };
        }
        const expectedSeq = head?.next_seq ?? 1;
        if (input.seq !== expectedSeq) {
          return { kind: "rejected", reason: "out-of-order", expectedSeq };
        }
        if (!head) {
          executeSqliteQuerySync(
            db,
            query(db).insertInto("worker_transcript_commit_heads").values({
              session_id: input.sessionId,
              run_epoch: input.runEpoch,
              environment_id: input.environmentId,
              next_seq: 1,
              updated_at_ms: input.nowMs,
            }),
          );
        }
        executeSqliteQuerySync(
          db,
          query(db).insertInto("worker_transcript_commits").values({
            session_id: input.sessionId,
            run_epoch: input.runEpoch,
            seq: input.seq,
            request_hash: input.requestHash,
            state: "pending",
            result_json: null,
            created_at_ms: input.nowMs,
            updated_at_ms: input.nowMs,
          }),
        );
        return { kind: "claimed" };
      },
      {
        operationLabel: "placementTranscript.begin",
        receipt: "result",
        transactionEnvironment: "process",
      },
    );
  },

  "placementTranscript.complete": (
    input: WorkerTranscriptCommitOperations["placementTranscript.complete"]["input"],
    { writeAdmitted },
  ): WorkerTranscriptCommitOutcome => {
    const resultJson = JSON.stringify(input.outcome);
    return writeAdmitted<WorkerTranscriptCommitOutcome>(
      ({ db }) => {
        const head = findHead(db, input);
        const commit = findCommit(db, input);
        const existing = classifyExistingCommit({ head, commit, input });
        if (!existing) {
          throw new Error("Worker transcript commit must begin before terminal completion");
        }
        if (existing.kind === "rejected") {
          throw new Error(
            `Worker transcript commit terminal completion rejected: ${existing.reason}`,
          );
        }
        if (existing.kind === "replay") {
          return existing.outcome;
        }
        if (!head) {
          throw new Error("Worker transcript commit row has no sequence head");
        }
        if (head.next_seq !== input.seq) {
          throw new Error(
            `Worker transcript commit terminal completion expected sequence ${head.next_seq}`,
          );
        }

        const commitUpdate = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_transcript_commits")
            .set({ state: "terminal", result_json: resultJson, updated_at_ms: input.nowMs })
            .where("session_id", "=", input.sessionId)
            .where("run_epoch", "=", input.runEpoch)
            .where("seq", "=", input.seq)
            .where("request_hash", "=", input.requestHash)
            .where("state", "=", "pending"),
        );
        if (commitUpdate.numAffectedRows !== 1n) {
          throw new Error("Worker transcript commit changed during terminal completion");
        }
        const headUpdate = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_transcript_commit_heads")
            .set({ next_seq: input.seq + 1, updated_at_ms: input.nowMs })
            .where("session_id", "=", input.sessionId)
            .where("run_epoch", "=", input.runEpoch)
            .where("environment_id", "=", input.environmentId)
            .where("next_seq", "=", input.seq),
        );
        if (headUpdate.numAffectedRows !== 1n) {
          throw new Error("Worker transcript commit sequence changed during terminal completion");
        }
        return input.outcome;
      },
      {
        operationLabel: "placementTranscript.complete",
        receipt: "result",
        transactionEnvironment: "process",
      },
    );
  },

  // Only the invocation that freshly claimed this row may discard it after a
  // known rollback. Recovered reservations can describe an already committed batch.
  "placementTranscript.discard": (
    input: WorkerTranscriptCommitOperations["placementTranscript.discard"]["input"],
    { writeAdmitted },
  ): true => {
    return writeAdmitted<true>(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          query(db)
            .deleteFrom("worker_transcript_commits")
            .where("session_id", "=", input.sessionId)
            .where("run_epoch", "=", input.runEpoch)
            .where("seq", "=", input.seq)
            .where("request_hash", "=", input.requestHash)
            .where("state", "=", "pending")
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom("worker_transcript_commit_heads")
                  .select("session_id")
                  .where("session_id", "=", input.sessionId)
                  .where("run_epoch", "=", input.runEpoch)
                  .where("environment_id", "=", input.environmentId)
                  .where("next_seq", "=", input.seq),
              ),
            ),
        );
        return true;
      },
      {
        operationLabel: "placementTranscript.discard",
        receipt: "result",
        transactionEnvironment: "process",
      },
    );
  },
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
