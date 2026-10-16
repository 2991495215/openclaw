import { AsyncLocalStorage } from "node:async_hooks";
import { yieldSessionListBackgroundWork } from "./session-projection-work.js";
import { identity, type EntryRow, type Row } from "./session-row-projection-record.js";
import {
  backfillSessionRowTranscriptFields,
  presentSessionRowTranscriptFields,
} from "./session-row-transcript-backfill.js";

function transcriptParams(row: Row, entry: EntryRow["entry"]) {
  return {
    ...row.storeTarget,
    agentId: row.agentId,
    storeAgentId: row.storeTarget.agentId,
    sessionKey: row.key,
    sessionId: entry.sessionId,
    sessionEntry: entry,
    model: row.materialized && {
      selectedProvider: row.materialized.source.selectedModel.provider,
      selectedModel: row.materialized.source.selectedModel.model,
      config: row.materialized.source.cfg,
    },
  };
}

/** Optional transcript work never participates in row readiness or a foreground response. */
export function createSessionRowProjectionBackfill(params: {
  ready: () => Promise<void>;
  read: (id: string) => Row | undefined;
  current: (row: Row) => boolean;
  publish: (row: Row, fields: ReturnType<typeof presentSessionRowTranscriptFields>) => void;
}) {
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const queued = new Set<string>();
  let pending: Promise<void> | undefined;
  let started = false;
  let disposed = false;
  async function drain() {
    for (;;) {
      if (disposed || !queued.size) {
        return;
      }
      await yieldSessionListBackgroundWork();
      await params.ready();
      if (disposed) {
        return;
      }
      const id = queued.values().next().value;
      if (id === undefined) {
        continue;
      }
      queued.delete(id);
      const row = params.read(id);
      const entry = row?.entry;
      if (!row || !entry) {
        continue;
      }
      const captured = row.retainedDatabaseFacts;
      try {
        const fields =
          captured?.transcriptPreview !== undefined &&
          captured.transcriptTerminalModel !== undefined
            ? {
                lastMessagePreview: captured.transcriptPreview,
                terminalModel: captured.transcriptTerminalModel,
              }
            : await backfillSessionRowTranscriptFields(transcriptParams(row, entry));
        const live = params.read(id);
        // A replacement/private-session revocation must not publish another session's text.
        if (!disposed && live?.entry && params.current(row)) {
          const facts = live.retainedDatabaseFacts;
          if (
            fields &&
            captured &&
            facts === captured &&
            (!live.pendingDatabaseFacts || live.pendingDatabaseFacts === captured)
          ) {
            // Enrich the same accepted snapshot without replacing pending metadata.
            facts.transcriptPreview = fields.lastMessagePreview;
            facts.transcriptTerminalModel = fields.terminalModel;
            queued.delete(id);
          }
          params.publish(
            live,
            facts?.transcriptPreview !== undefined && facts.transcriptTerminalModel !== undefined
              ? presentSessionRowTranscriptFields(transcriptParams(live, live.entry), {
                  lastMessagePreview: facts.transcriptPreview,
                  terminalModel: facts.transcriptTerminalModel,
                })
              : fields
                ? presentSessionRowTranscriptFields(transcriptParams(live, live.entry), fields)
                : {},
          );
        }
      } catch {
        // A later owner publication retries optional fields; do not spin on a cold/error row.
      }
    }
  }
  function start() {
    started = true;
    if (!disposed && !pending && queued.size) {
      pending = inOwnerContext(drain).then(
        () => {
          pending = undefined;
          start();
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      );
      void pending.catch(() => {});
    }
  }
  return {
    start,
    prepare(row: EntryRow, facts: Row["retainedDatabaseFacts"]) {
      const id = identity(row);
      if (facts?.transcriptPreview !== undefined && facts.transcriptTerminalModel !== undefined) {
        queued.delete(id);
        params.publish(
          row,
          presentSessionRowTranscriptFields(transcriptParams(row, row.entry), {
            lastMessagePreview: facts.transcriptPreview,
            terminalModel: facts.transcriptTerminalModel,
          }),
        );
        return;
      }
      queued.add(id);
      if (started) {
        start();
      }
    },
    remove(this: void, id: string) {
      queued.delete(id);
    },
    dispose() {
      disposed = true;
      queued.clear();
    },
  };
}
