import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  isAssistantResultEventForRun,
  isVisibleAssistantResultEventForRun,
} from "../../sessions/transcript-visible-record.js";
import {
  isSilentAssistantTranscriptMessage,
  readTerminalSourceReplyDeliveryMirror,
} from "../../shared/chat-message-content.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { hashSessionArchiveBytes } from "./session-accessor.sqlite-archive-artifact.js";
import { readTranscriptArchiveRecords } from "./session-accessor.sqlite-archive-stream.js";
import type {
  TranscriptArchivePresenceRead,
  TranscriptArchiveReadPlan,
  TranscriptArchiveReadResult,
} from "./session-accessor.sqlite-archive-types.js";
import type { TranscriptEvent } from "./session-accessor.types.js";

type ArchiveDatabase = Pick<DB, "session_transcript_archives">;

export function listTranscriptArchivesFromDatabase(
  { db, agentId }: Pick<OpenClawAgentDatabase, "db" | "agentId">,
  logicalAgentId: string | undefined,
  selectors: readonly string[],
  archiveNames: readonly string[],
) {
  // Archive metadata is optional until the first archive write.
  if (!tableExists(db, "session_transcript_archives")) {
    return [];
  }
  const selected = sqliteStringSet(selectors);
  const query = getNodeSqliteKysely<ArchiveDatabase>(db)
    .selectFrom("session_transcript_archives")
    .select([
      "archive_name as archiveName",
      "session_id as sessionId",
      "session_key as sessionKey",
      "created_at as createdAt",
    ])
    .orderBy("created_at")
    .orderBy("session_id")
    .where((expression) =>
      expression.or([
        ...(selectors.length > 0
          ? [expression("session_id", "in", selected), expression("session_key", "in", selected)]
          : []),
        ...(archiveNames.length > 0
          ? [expression("archive_name", "in", sqliteStringSet(archiveNames))]
          : []),
      ]),
    );
  const rows = executeSqliteQuerySync(db, query).rows;
  return rows
    .map((row) =>
      Object.assign(row, { agentId: resolveAgentIdFromSessionKey(row.sessionKey, agentId) }),
    )
    .filter((row) => logicalAgentId === undefined || row.agentId === logicalAgentId);
}

function hasTranscriptArchiveInDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "agentId">,
  target: Pick<TranscriptArchiveReadPlan, "logicalAgentId" | "sessionId" | "sessionKey">,
): boolean {
  return listTranscriptArchivesFromDatabase(
    database,
    target.logicalAgentId,
    [target.sessionId ?? target.sessionKey],
    [],
  ).some((archive) =>
    target.sessionId
      ? archive.sessionId === target.sessionId
      : archive.sessionKey === target.sessionKey,
  );
}

export function readTranscriptArchivePresenceInWorker(
  request: TranscriptArchivePresenceRead,
): boolean {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const actual = readOpenClawAgentDatabaseIdentity(database);
      if (
        typeof actual.identity !== "string" ||
        `file:${actual.identity}` !== request.expectedIdentity.key ||
        actual.birthtime !== request.expectedIdentity.birthtime
      ) {
        throw new Error("SQLite archive metadata changed its captured database owner");
      }
      return hasTranscriptArchiveInDatabase(database, request);
    },
    { ...request.database, env: request.env },
  );
  return result.found && result.value;
}

/** Scan one canonical read snapshot without constructing the decoded history. */
export async function readTranscriptArchiveFinalInWorker(
  plan: TranscriptArchiveReadPlan,
  env: NodeJS.ProcessEnv,
): Promise<TranscriptArchiveReadResult> {
  const opened = openOpenClawAgentDatabaseReadOnly({
    agentId: plan.agentId,
    path: plan.databasePath,
    env,
  });
  if (!opened.found) {
    return {};
  }
  const database = opened.database;
  let transactionOpen = false;
  try {
    if (plan.expectedIdentity) {
      const actual = readOpenClawAgentDatabaseIdentity(database);
      if (
        typeof actual.identity !== "string" ||
        `file:${actual.identity}` !== plan.expectedIdentity.key ||
        actual.birthtime !== plan.expectedIdentity.birthtime
      ) {
        throw new Error("SQLite archive read changed its captured database owner");
      }
    }
    database.db.exec("BEGIN"); // sqlite-allow-raw: keep archive identities and bytes in one read snapshot.
    transactionOpen = true;
    const archives = listTranscriptArchivesFromDatabase(
      database,
      plan.logicalAgentId,
      [plan.sessionId ?? plan.sessionKey],
      [],
    ).toReversed();
    const result: TranscriptArchiveReadResult = {};
    for (const archive of archives) {
      if (
        plan.sessionId
          ? archive.sessionId !== plan.sessionId
          : archive.sessionKey !== plan.sessionKey
      ) {
        continue;
      }
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        getNodeSqliteKysely<ArchiveDatabase>(database.db)
          .selectFrom("session_transcript_archives")
          .select(["archive_blob", "archive_sha256", "encoding"])
          .where("archive_name", "=", archive.archiveName)
          .where("session_id", "=", archive.sessionId)
          .where("session_key", "=", archive.sessionKey),
      );
      if (!row) {
        continue;
      }
      if (hashSessionArchiveBytes(row.archive_blob) !== row.archive_sha256) {
        throw new Error("Archived transcript bytes do not match their registered hash.");
      }
      let hasTerminalResult = false;
      await scanArchivedTranscript(
        row.archive_blob,
        row.encoding === "zstd",
        archive.sessionId,
        (event) => {
          if (!isAssistantResultEventForRun(event, plan.runId)) {
            return;
          }
          hasTerminalResult = true;
          if (isVisibleAssistantResultEventForRun(event, plan.runId)) {
            result.event = event;
          } else if (isRecord(event) && isSilentAssistantTranscriptMessage(event.message)) {
            const previousMessage = isRecord(result.event) ? result.event.message : undefined;
            if (
              !(isRecord(previousMessage) && previousMessage.display === true) &&
              !readTerminalSourceReplyDeliveryMirror(previousMessage)
            ) {
              result.event = undefined;
            }
          }
        },
      );
      if (hasTerminalResult) {
        break;
      }
    }
    database.db.exec("COMMIT"); // sqlite-allow-raw: release the completed read snapshot.
    transactionOpen = false;
    return result;
  } finally {
    try {
      if (transactionOpen) {
        database.db.exec("ROLLBACK"); // sqlite-allow-raw: release a failed read snapshot.
      }
    } finally {
      database.close();
    }
  }
}

async function scanArchivedTranscript(
  bytes: Uint8Array,
  compressed: boolean,
  sessionId: string,
  visit: (event: TranscriptEvent) => void,
): Promise<void> {
  const input = Readable.from(
    (function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        yield bytes.subarray(offset, offset + 64 * 1024);
      }
    })(),
  );
  const optionalZlib: Partial<typeof zlib> = zlib;
  const createZstdDecompress = optionalZlib.createZstdDecompress;
  if (compressed && !createZstdDecompress) {
    throw new Error("Cannot decode compressed transcript archive: this runtime lacks zstd support");
  }
  let headerRead = false;
  const scan = async (source: Readable) => {
    for await (const record of readTranscriptArchiveRecords(source)) {
      const event: unknown = JSON.parse(record.toString("utf8"));
      if (!headerRead) {
        if (!isRecord(event) || event.type !== "session" || event.id !== sessionId) {
          throw new Error("Archived transcript header does not match its registered session.");
        }
        headerRead = true;
      } else {
        visit(event);
      }
    }
  };
  await pipeline([
    input,
    ...(compressed && createZstdDecompress ? [createZstdDecompress.call(zlib)] : []),
    scan,
  ]);
  if (!headerRead) {
    throw new Error("Archived transcript header does not match its registered session.");
  }
}
