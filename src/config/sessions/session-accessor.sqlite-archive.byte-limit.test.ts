import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { readTranscriptArchiveRecords } from "./session-accessor.sqlite-archive-stream.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-delete-snapshot.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

vi.mock("./session-accessor.sqlite-archive-artifact.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-archive-artifact.js")>();
  return { ...actual, MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES: 1024 };
});

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-archive-byte-limit-");

describe("SQLite transcript archive byte limit", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  it("bounds each framed record before reading more input and excludes its final newline", async () => {
    async function* chunks() {
      yield Buffer.from('{"x":');
      yield Buffer.from('"xx"}');
      throw new Error("Read beyond the record capacity");
    }
    await expect(readTranscriptArchiveRecords(chunks(), 8).next()).rejects.toThrow(
      "record exceeds the task-history read capacity",
    );
    async function* exact() {
      yield Buffer.from('{\n"x":0');
      yield Buffer.from("}\n{}");
    }
    const records = [];
    for await (const record of readTranscriptArchiveRecords(exact(), 8)) {
      records.push(record.toString("utf8"));
    }
    expect(records).toEqual(['{\n"x":0}', "{}"]);
    async function* uncapped() {
      yield Buffer.from('{"x":"xx"}');
    }
    await expect(readTranscriptArchiveRecords(uncapped()).next()).resolves.toMatchObject({
      value: Buffer.from('{"x":"xx"}'),
      done: false,
    });
  });

  it("aborts encoded output at the cap and removes staging files", async () => {
    const sessionId = "archive-output-overflow";
    const sessionKey = "agent:main:archive-output-overflow";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      {
        type: "session",
        id: sessionId,
        content: randomBytes(4096).toString("base64"),
      },
    ]);

    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    if (!target.path) {
      throw new Error("expected SQLite target path");
    }
    const database = openOpenClawAgentDatabase({
      agentId: target.agentId ?? "main",
      path: target.path,
    });
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      database,
      referencedSessionIds: new Set(),
      sessionId,
    });
    if (!plan) {
      throw new Error("expected archive plan");
    }
    closeOpenClawAgentDatabasesForTest();
    const { materializeTranscriptArchiveInWorker } =
      await import("./session-accessor.sqlite-archive.worker.js");

    await expect(materializeTranscriptArchiveInWorker(plan)).rejects.toThrow(
      "Archive exceeds 1024 bytes during encoding",
    );
    expect(
      fs
        .readdirSync(path.dirname(storePath))
        .filter((entry) => entry.includes(".stage") || entry.includes("jsonl-stage")),
    ).toEqual([]);
  });
});
