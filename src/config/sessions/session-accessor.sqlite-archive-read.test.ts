import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { buffer as consumeBuffer } from "node:stream/consumers";
import zlib from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { assertOpenClawAgentCurrentRuntimeSchema } from "../../state/openclaw-agent-db-schema-helpers.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as archiveCompression from "./archive-compression.js";
import { deleteSessionEntryLifecycle, findTranscriptEvent } from "./session-accessor.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import * as history from "./session-history.js";
import * as historyReaders from "./session-transcript-worker-readers.js";

const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);
const jsonLines = (events: readonly unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function assistantMessage<T>(id: string | undefined, content: T, runId: string, display?: true) {
  return {
    type: "message",
    ...(id === undefined ? {} : { id }),
    message: { role: "assistant", content, ...(display ? { display } : {}), __openclaw: { runId } },
  };
}

function archiveRow(
  sessionId: string,
  sessionKey: string,
  bytes: Buffer,
  options: { generation?: string; encoding?: "identity" | "zstd"; name: string; createdAt: number },
) {
  return {
    session_id: sessionId,
    session_key: sessionKey,
    generation: options.generation ?? "generation",
    reason: "deleted" as const,
    encoding: options.encoding ?? "identity",
    archive_blob: bytes,
    archive_sha256: digest(bytes),
    archive_name: options.name,
    created_at: options.createdAt,
    published_at: null,
  };
}

function createArchiveStore(label: string, filename = "archive.sqlite") {
  const env = { OPENCLAW_STATE_DIR: autoTempDirs.make(label) };
  const storePath = path.join(env.OPENCLAW_STATE_DIR, filename);
  const options = { agentId: "main", env, path: storePath };
  const database = agentDb.openOpenClawAgentDatabase(options);
  const sql = getSessionKysely(database.db);
  const write = (query: Parameters<typeof executeSqliteQuerySync>[1]) =>
    agentDb.runOpenClawAgentWriteTransaction(
      () => executeSqliteQuerySync(database.db, query),
      options,
    );
  return {
    env,
    storePath,
    database,
    insert: (rows: ReturnType<typeof archiveRow> | ReturnType<typeof archiveRow>[]) =>
      write(sql.insertInto("session_transcript_archives").values(rows)),
    update: (
      id: string,
      row: Partial<ReturnType<typeof archiveRow>>,
      column: "generation" | "session_id" = "generation",
    ) => write(sql.updateTable("session_transcript_archives").set(row).where(column, "=", id)),
  };
}

async function withoutHostSql<T>(read: () => Promise<T>): Promise<T> {
  const hostSql = observeHostDataSql();
  const result = await read().finally(() => hostSql.restore());
  expect(hostSql.queries).toEqual([]);
  for (const call of hostSql.calls) {
    expect(call).not.toHaveBeenCalled();
  }
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  agentDb.closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("reads a pre-archive store without creating its optional archive table", async () => {
  await withOpenClawTestState({ label: "optional-archive-read" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const archiveRead = vi.spyOn(archiveWorker, "runSqliteTranscriptArchiveReadWorker");
    const missingPath = state.statePath("missing.sqlite");
    await expect(
      withoutHostSql(() =>
        history.findSessionTranscriptArchiveEventReadOnly(
          { ...options, storePath: missingPath, sessionKey: "agent:main:missing" },
          "absent-run",
        ),
      ),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(missingPath)).toBe(false);
    expect(archiveRead).not.toHaveBeenCalled();
    const database = agentDb.openOpenClawAgentDatabase(options);
    database.db.exec("DROP TABLE session_transcript_archives");
    assertOpenClawAgentCurrentRuntimeSchema(requireNativeSqliteDatabase(database.db), {
      agentId: database.agentId,
      pathname: database.path,
    });
    const storePath = database.path;
    agentDb.closeOpenClawAgentDatabasesForTest();
    const before = fs.readFileSync(storePath);
    const scope = {
      ...options,
      storePath,
      sessionKey: "agent:main:pre-archive",
      sessionId: "pre-archive",
    };

    expect(
      history.listSessionTranscriptArchivesReadOnly({ ...scope, sessionIds: [scope.sessionId] }),
    ).toEqual([]);
    await expect(
      withoutHostSql(() => history.findSessionTranscriptArchiveEventReadOnly(scope, "absent-run")),
    ).resolves.toBeUndefined();
    expect(archiveRead).not.toHaveBeenCalled();
    archiveRead.mockRestore();
    {
      using persisted = new DatabaseSync(storePath, { readOnly: true });
      expect(
        persisted
          .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_transcript_archives'")
          .get(),
      ).toBeUndefined();
    }
    expect(fs.readFileSync(storePath)).toEqual(before);
  });
});

it.each([false, true])(
  "reads committed archive blobs before file publication (compressed=%s)",
  async (compressed) => {
    const { env, storePath, database, insert, update } = createArchiveStore(
      "openclaw-archive-blob-read-",
      "shared.sqlite",
    );
    const sessionKey = "agent:ops:completed";
    const message = (id: string, content = id, runId = "completed-run") =>
      assistantMessage(id, content, runId);
    const answer = assistantMessage(
      "latest",
      `${'你好 🦞 {result} "quoted" \\ '.repeat(4_000)}tail`,
      "completed-run",
      true,
    );
    const archives: Array<[string, string, unknown[], string?]> = [
      ["old", sessionKey, [message("old")]],
      [
        "new",
        sessionKey,
        [
          message("earlier"),
          answer,
          message("other-run", "unrelated", "other-run"),
          message("silent", "NO_REPLY"),
        ],
      ],
      ["foreign", "agent:main:other", [answer]],
      ["invalid", "agent:ops:invalid", [answer]],
      ["malformed", "agent:ops:malformed", [answer], '\n{\n"message": !\n}\n'],
      ["truncated", "agent:ops:truncated", [answer], '\n{\n"message": {\n'],
    ];
    insert(
      archives.map(([sessionId, key, events, suffix], index) => {
        const content =
          jsonLines([
            { type: "session", id: sessionId === "invalid" ? "wrong" : sessionId },
            ...events,
          ]) + (suffix ?? "");
        const encoded = compressed
          ? archiveCompression.encodeSessionArchiveContent(content)
          : { bytes: Buffer.from(content), suffix: "" };
        return archiveRow(sessionId, key, encoded.bytes, {
          encoding: encoded.suffix ? "zstd" : "identity",
          name: `archive-${index}.jsonl${encoded.suffix}`,
          createdAt: index,
        });
      }),
    );
    const scope = { agentId: "ops", env, storePath, sessionKey };
    const find = (sessionId?: string, runId = "completed-run") =>
      history.findSessionTranscriptArchiveEventReadOnly(
        { ...scope, ...(sessionId ? { sessionId } : {}) },
        runId,
      );
    const files = () =>
      fs
        .readdirSync(env.OPENCLAW_STATE_DIR, { recursive: true, encoding: "utf8" })
        .toSorted((left, right) => left.localeCompare(right));
    const filesBefore = files();

    expect(await withoutHostSql(() => find())).toEqual({ event: answer });
    expect(await find("old")).toEqual({ event: message("old") });
    expect(await find("foreign")).toBeUndefined();
    expect(await find(undefined, "missing-run")).toBeUndefined();
    await expect(find("invalid")).rejects.toThrow(
      "Archived transcript header does not match its registered session",
    );
    for (const sessionId of ["malformed", "truncated"]) {
      await expect(find(sessionId)).rejects.toThrow();
    }
    expect(files()).toEqual(filesBefore);
    expect(
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_transcript_archives")
          .select("published_at"),
      ).rows,
    ).toEqual(archives.map(() => ({ published_at: null })));

    const changedContent = jsonLines([
      { type: "session", id: "new" },
      message("latest", "changed but valid transcript content"),
    ]);
    const changedBytes = compressed
      ? archiveCompression.encodeSessionArchiveContent(changedContent).bytes
      : Buffer.from(changedContent);
    update("new", { archive_blob: changedBytes }, "session_id");
    await expect(find("new")).rejects.toThrow(
      "Archived transcript bytes do not match their registered hash",
    );

    const entered = createDeferred();
    const release = createDeferred();
    const hold = async <T>(value: T) => {
      entered.resolve();
      await release.promise;
      return value;
    };
    const replacementPath = `${storePath}.replacement`;
    const originalPath = `${storePath}.original`;
    const intercept = async () => {
      if (!compressed) {
        const createReaders = historyReaders.createSessionHistoryWorkerReaders;
        return vi
          .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
          .mockImplementation((runRequest) => {
            const readers = createReaders(runRequest);
            return {
              ...readers,
              readArchivePresence: async (input) => hold(await readers.readArchivePresence(input)),
            };
          });
      }
      await agentDb.closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
      fs.copyFileSync(storePath, replacementPath);
      expect(fs.readFileSync(replacementPath)).toEqual(fs.readFileSync(storePath));
      const scopeOwner = await import("./session-accessor.sqlite-scope.js");
      const prepare = scopeOwner.prepareSqliteScope;
      return vi
        .spyOn(scopeOwner, "prepareSqliteScope")
        .mockImplementation(async (input) => hold(await prepare(input)));
    };
    const interception = await intercept();
    const archiveRead = vi.spyOn(archiveWorker, "runSqliteTranscriptArchiveReadWorker");
    const outcome = find("old").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let closing: Promise<void> | undefined;
    let originalMoved = false;
    let replacementMoved = false;
    try {
      await Promise.race([
        entered.promise,
        outcome.then(() => {
          throw new Error(
            `Archive lookup settled before its ${compressed ? "scope preparation" : "metadata"} hold`,
          );
        }),
      ]);
      if (compressed) {
        fs.renameSync(storePath, originalPath);
        originalMoved = true;
        fs.renameSync(replacementPath, storePath);
        replacementMoved = true;
      } else {
        closing = agentDb.closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
      }
      release.resolve();
      expect(await outcome).toMatchObject({
        error: { message: expect.stringMatching(compressed ? /identity changed/ : /revoked/) },
      });
      await closing;
      expect(archiveRead).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([outcome, closing]);
      if (compressed) {
        await agentDb.closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
        if (replacementMoved) {
          fs.renameSync(storePath, replacementPath);
        }
        if (originalMoved) {
          fs.renameSync(originalPath, storePath);
        }
      }
      archiveRead.mockRestore();
      interception.mockRestore();
    }
  },
);

it("retains exact multiline imported events through deletion and final-answer lookup", async () => {
  await withOpenClawTestState({ label: "archive-multiline" }, async (state) => {
    const sessionId = "imported-child";
    const sessionKey = "agent:main:subagent:imported-child";
    const runId = "imported-child-run";
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId,
      sessionKey,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const answer = {
      ...assistantMessage(
        "answer",
        [{ type: "text", text: 'Complete result: {"answer": "你好 🦞"}.' }],
        runId,
      ),
      parentId: "user",
    };
    const rows = [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "user",
        parentId: null,
        message: { role: "user", content: 'Keep braces {}, brackets [] and \\"quotes\\".' },
      },
      answer,
    ].map((event, index) => ({
      session_id: sessionId,
      seq: index,
      created_at: index + 1,
      event_json: JSON.stringify(event, null, 2),
    }));
    await seedUnindexedTranscriptForTest({
      ...scope,
      entry: { sessionId, updatedAt: 3 },
      events: rows,
    });
    await expect(findTranscriptEvent(scope, { kind: "visible-final", runId })).resolves.toEqual({
      event: answer,
    });

    const deletion = await deleteSessionEntryLifecycle({
      ...scope,
      archiveTranscript: true,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    expect(deletion.deleted).toBe(true);
    expect(deletion.archivedTranscripts).toHaveLength(1);
    const archivePath = deletion.archivedTranscripts[0]!.archivedPath;
    expect(archiveCompression.readSessionArchiveContentSync(archivePath)).toBe(
      `${rows.map((row) => row.event_json).join("\n")}\n`,
    );
    await expect(history.findSessionTranscriptArchiveEventReadOnly(scope, runId)).resolves.toEqual({
      event: answer,
    });
  });
});

it("reads a short final answer beyond the runtime string limit while the caller stays responsive", async () => {
  const { env, storePath, insert } = createArchiveStore("openclaw-large-archive-read-");
  const sessionId = "large-archive";
  const sessionKey = "agent:main:completed";
  const answer = assistantMessage(undefined, "Complete final answer.", "completed-run");
  const historyLine =
    JSON.stringify({
      type: "message",
      message: { role: "user", content: "x".repeat(64 * 1024) },
    }) + "\n";
  // The September 2026 failure was the runtime's single-string limit, not an archive byte limit.
  const historyRows = Math.ceil((bufferConstants.MAX_STRING_LENGTH + 1) / historyLine.length);
  const compressed = Readable.from([
    JSON.stringify({ type: "session", id: sessionId }) + "\n",
    ...Array.from({ length: historyRows }, () => historyLine),
    JSON.stringify(answer) + "\n",
  ]).pipe(zlib.createZstdCompress());
  const bytes = await consumeBuffer(compressed);
  insert(
    archiveRow(sessionId, sessionKey, bytes, {
      encoding: "zstd",
      name: "large.jsonl.zst",
      createdAt: 1,
    }),
  );
  let heartbeats = 0;
  const heartbeat = setInterval(() => {
    heartbeats += 1;
  }, 10);
  try {
    await expect(
      history.findSessionTranscriptArchiveEventReadOnly(
        { agentId: "main", env, storePath, sessionId, sessionKey },
        "completed-run",
      ),
    ).resolves.toEqual({ event: answer });
    expect(heartbeats).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "large.jsonl.zst"))).toBe(false);
  } finally {
    clearInterval(heartbeat);
  }
}, 30_000);
