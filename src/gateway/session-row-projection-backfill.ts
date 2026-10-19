import { AsyncLocalStorage } from "node:async_hooks";
import { yieldSessionListBackgroundWork } from "./session-projection-work.js";
import { hasEntry, identity, type EntryRow, type Row } from "./session-row-projection-record.js";
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
  function publishPrepared(row: EntryRow, facts: Row["retainedDatabaseFacts"]) {
    if (facts?.transcriptPreview === undefined || facts.transcriptTerminalModel === undefined) {
      return false;
    }
    params.publish(
      row,
      presentSessionRowTranscriptFields(transcriptParams(row, row.entry), {
        lastMessagePreview: facts.transcriptPreview,
        lastAssistantMessage:
          facts.transcriptAssistantMessage === "unknown"
            ? (row.lastAssistantMessage ?? null)
            : facts.transcriptAssistantMessage,
        terminalModel: facts.transcriptTerminalModel,
      }),
    );
    return facts.transcriptAssistantMessage !== "unknown";
  }
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
      const captured = row?.retainedDatabaseFacts;
      if (
        !hasEntry(row) ||
        (captured?.transcriptAssistantMessage !== "unknown" && publishPrepared(row, captured))
      ) {
        continue;
      }
      try {
        const fields = await backfillSessionRowTranscriptFields(transcriptParams(row, row.entry));
        const live = params.read(id);
        // A replacement/private-session revocation must not publish another session's text.
        if (!disposed && hasEntry(live) && params.current(row)) {
          const facts = live.retainedDatabaseFacts;
          // Committed receipts beat optional work, including a queued read's result.
          if (facts?.transcriptAssistantMessage !== "unknown" && publishPrepared(live, facts)) {
            continue;
          }
          // A new facts object needs its own read; never refill a cleared snapshot.
          if (
            !captured ||
            facts !== captured ||
            (live.pendingDatabaseFacts && live.pendingDatabaseFacts !== captured)
          ) {
            continue;
          }
          if (fields) {
            facts.transcriptPreview = fields.lastMessagePreview;
            facts.transcriptAssistantMessage = fields.lastAssistantMessage;
            facts.transcriptTerminalModel = fields.terminalModel;
          }
          // Coalesced notifications of this same snapshot owe no second read.
          queued.delete(id);
          params.publish(
            live,
            fields
              ? presentSessionRowTranscriptFields(transcriptParams(live, live.entry), fields)
              : {},
          );
        }
      } catch {
        // A later owner publication retries optional fields; do not spin on a cold/error row.
        if (params.read(id)?.retainedDatabaseFacts === captured) {
          queued.delete(id);
        }
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
      if (publishPrepared(row, facts)) {
        queued.delete(id);
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
