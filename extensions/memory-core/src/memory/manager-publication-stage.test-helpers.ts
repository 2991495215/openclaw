import { channel } from "node:diagnostics_channel";
import {
  withEngineStoreAdmission,
  type EngineConnection,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { expect, it } from "vitest";
import type { MemoryPublicationState } from "./manager-publication-task.js";
import {
  memoryPublicationBatches,
  memoryPublicationHeader,
} from "./manager-publication-transfer.js";
import type { bindSqliteWorkerBackend } from "./manager-publication.worker.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import { readMemoryDatabaseFacts } from "./manager-retrieval-read.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

type PublicationRows = ReturnType<ReturnType<EngineConnection["prepare"]>["all"]>;
type ReindexStageTestContext = {
  pg: () => EngineConnection;
  execute: ReturnType<typeof bindSqliteWorkerBackend>["execute"];
  rebind: (stageId?: string) => void;
  setDenyCommit: (denied: boolean) => void;
  replacement: (name: string, text?: string) => MemorySourceIndexReplacement;
  publishInline: (
    value: MemorySourceIndexReplacement,
  ) => ReturnType<ReturnType<typeof bindSqliteWorkerBackend>["execute"]>;
  rows: () => PublicationRows;
  keyword: (term: string) => PublicationRows;
  state: MemoryPublicationState;
  metadata: MemoryIndexMeta;
};

export function registerReindexStageTests({
  pg,
  execute,
  rebind: bind,
  setDenyCommit,
  replacement,
  publishInline,
  rows,
  keyword,
  state,
  metadata,
}: ReindexStageTestContext): void {
  it.each(["complete", "empty"] as const)(
    "retains a private full reindex across short bindings and rolls back a refused commit (%s)",
    (mode) =>
      withEngineStoreAdmission(() => {
        const probes: string[] = [];
        const observations = channel("openclaw.database.statement");
        const listener = (message: unknown) => {
          const event = message as { engine: string; sql: string };
          if (
            event.engine === "postgres" &&
            /^SELECT \? FROM memory_stage_\w+ WHERE lane = \? AND last = \? LIMIT \?$/iu.test(
              event.sql,
            )
          ) {
            probes.push(event.sql);
          }
        };
        const rebind = (id?: string) => {
          bind(id);
          expect(pg().isTransaction).toBe(false);
        };
        observations.subscribe(listener);
        try {
          expect(publishInline(replacement("old"))).toMatchObject({ ok: true });
          expect(execute({ type: "index.writeMetadata", input: metadata })).toMatchObject({
            ok: true,
          });
          const before = rows();
          const revision = readMemoryDatabaseFacts(pg()).revision;
          const stageId = `full-reindex-${mode}`;
          rebind(stageId);
          expect(execute({ type: "database.stage.start", input: undefined })).toMatchObject({
            ok: true,
          });
          rebind(stageId);
          const next = replacement("new", `new ${"replacement ".repeat(24_000)}`);
          if (mode === "empty") {
            next.chunks = [];
            next.embeddings = [];
          }
          const batches = [...memoryPublicationBatches(next)];
          if (mode === "complete") {
            expect(batches.length).toBeGreaterThan(1);
          } else {
            expect(batches).toEqual([]);
          }
          execute({ type: "stage.start", input: { header: memoryPublicationHeader(next) } });
          rebind(stageId);
          for (const [index, fragments] of batches.entries()) {
            if (index === batches.length - 1) {
              expect(fragments.some((fragment) => fragment.last)).toBe(true);
              setDenyCommit(true);
              expect(() => execute({ type: "stage.append", input: { fragments } })).toThrow(
                "publication authority revoked",
              );
              setDenyCommit(false);
              rebind(stageId);
              expect(rows()).toEqual(before);
            }
            execute({ type: "stage.append", input: { fragments } });
            rebind(stageId);
            expect(rows()).toEqual(before);
          }
          expect(execute({ type: "source.replace", input: { state } })).toMatchObject({
            ok: true,
            facts: {
              hasIndexedChunks: mode === "complete",
              hasSemanticChunks: mode === "complete",
            },
          });
          rebind(stageId);
          expect(
            execute({
              type: "index.writeMetadata",
              input: { ...metadata, chunkTokens: 200 },
            }),
          ).toMatchObject({ ok: true });
          rebind();
          expect(rows()).toEqual(before);
          expect(keyword("new")).toEqual([]);
          expect(keyword("old")).toEqual([{ path: "memory/old.md" }]);
          setDenyCommit(true);
          expect(
            execute({
              type: "database.stage.publish",
              input: { stageId, expectedRevision: revision, vectorIndexComplete: true },
            }),
          ).toMatchObject({
            ok: false,
            entered: true,
            committed: false,
            error: { message: "publication authority revoked" },
          });
          expect(rows()).toEqual(before);
          expect(keyword("old")).toEqual([{ path: "memory/old.md" }]);
          expect(readMemoryDatabaseFacts(pg()).revision).toBe(revision);
          setDenyCommit(false);
          rebind();
          expect(
            execute({
              type: "database.stage.publish",
              input: { stageId, expectedRevision: revision, vectorIndexComplete: true },
            }),
          ).toMatchObject({ ok: true });
          expect(rows()).toEqual(
            mode === "complete"
              ? [{ path: "memory/new.md", text: next.chunks[0]!.text, vector: "[1,0,0]" }]
              : [],
          );
          expect(keyword("old")).toEqual([]);
          expect(keyword("new")).toEqual(mode === "complete" ? [{ path: "memory/new.md" }] : []);
          expect(execute({ type: "index.facts", input: undefined })).toMatchObject({
            meta: { chunkTokens: 200 },
            vectorState: { state: mode === "complete" ? "complete" : "empty" },
            revision: revision + 1,
          });
          execute({ type: "database.stage.discard", input: { stageId } });
          expect(() =>
            execute({
              type: "database.stage.publish",
              input: { stageId, expectedRevision: revision, vectorIndexComplete: true },
            }),
          ).toThrow("Memory reindex connection was lost");
          expect(rows()).toHaveLength(mode === "complete" ? 1 : 0);
          expect(probes).toEqual([]);
        } finally {
          setDenyCommit(false);
          observations.unsubscribe(listener);
        }
      }),
  );
}
