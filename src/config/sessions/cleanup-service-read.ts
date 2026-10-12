import {
  assertExistingDatabaseIdentity,
  type DatabaseFileIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { shouldPreserveSessionCleanupEntry } from "./cleanup-service-read.policy.js";
import type { SessionCleanupReadResult } from "./cleanup-service-read.types.js";
import type { ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import { captureSessionStoreCandidateIdentities } from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";
import type { SessionStoreTarget } from "./targets.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export type SessionCleanupSource = {
  database: { agentId: string; path: string; env: NodeJS.ProcessEnv };
  identity?: DatabaseFileIdentity;
  memoryIncarnation?: string | null;
};

type SessionCleanupStoreOwner = {
  source: SessionCleanupSource;
  resolved: ResolvedSqliteScope & { env: NodeJS.ProcessEnv; path: string };
  assertCurrent: () => void;
  read: (fixMissing?: boolean) => Promise<SessionCleanupReadResult>;
};
type SessionCleanupStoreOptions = { source?: SessionCleanupSource; assertCurrent?: () => void };

/** Retain the preview's physical owner through fresh classification and lifecycle settlement. */
export function withSessionCleanupStore<T>(
  target: SessionStoreTarget,
  consume: (owner: SessionCleanupStoreOwner) => Promise<T>,
  options: SessionCleanupStoreOptions = {},
): Promise<T> {
  const env = captureSessionTranscriptStorageEnvironment(
    options.source?.database.env ?? process.env,
  );
  const path = resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).path;
  if (isIncognitoOpenClawAgentSqlitePath(path, { agentId: target.agentId, env })) {
    return withMemorySessionCleanupStore(
      target,
      { agentId: target.agentId, path, env },
      consume,
      options,
    );
  }
  const identities = captureSessionStoreCandidateIdentities(
    captureSessionStoreReadCandidates(target.storePath),
  );
  let identity: DatabaseFileIdentity | undefined;
  return withSessionStoreReaderInWorker(
    { ...target, env },
    async ({ reader, database, logicalAgentId, continuation, assertCurrent: assertReader }) => {
      const source = { database, identity };
      const assertCurrent = () => {
        assertReader();
        options.assertCurrent?.();
        if (
          options.source &&
          (database.path !== options.source.database.path ||
            database.agentId !== options.source.database.agentId)
        ) {
          throw new Error("Session cleanup changed its physical store");
        }
        for (const expected of [options.source?.identity, identity]) {
          if (expected) {
            assertExistingDatabaseIdentity(database.path, expected.key, expected.birthtime);
          }
        }
      };
      assertCurrent();
      const result = await consume({
        source,
        resolved: {
          agentId: logicalAgentId,
          databaseAgentId: database.agentId,
          path: database.path,
          env: database.env,
          sessionKey: "",
          ownerStorePath: target.storePath,
        },
        assertCurrent,
        read: async (fixMissing = false) => {
          assertCurrent();
          const snapshot = await reader.readCleanup({
            env: database.env,
            expectedIdentity: identity && { ...identity, canonicalPath: database.path },
            continuation,
            fixMissing,
          });
          if (!identity && snapshot.source) {
            identity = {
              key: `file:${snapshot.source.databaseIdentity}`,
              birthtime: snapshot.source.databaseBirthtime,
            };
            source.identity = identity;
          }
          assertCurrent();
          return snapshot;
        },
      });
      assertCurrent();
      return result;
    },
    {
      lane: maintenanceLane,
      logical: { assertCurrent: options.assertCurrent },
      prepareSource: (database, captured) => {
        const original = identities.get(captured.canonicalPath);
        if (captured.key.startsWith("file:")) {
          if (
            !original ||
            original.key !== captured.key ||
            original.birthtime !== captured.birthtime
          ) {
            throw new Error("Session cleanup changed its physical owner during discovery");
          }
          assertExistingDatabaseIdentity(database.path, original.key, original.birthtime);
          identity = original;
        }
      },
    },
  );
}

/** A memory preview retains the same actor namespace through classification and consumption. */
async function withMemorySessionCleanupStore<T>(
  target: SessionStoreTarget,
  database: SessionCleanupSource["database"],
  consume: (owner: SessionCleanupStoreOwner) => Promise<T>,
  options: SessionCleanupStoreOptions,
): Promise<T> {
  const assertCaller = () => options.assertCurrent?.();
  const authority = { assertCurrent: assertCaller, authorize: assertCaller };
  const captured = captureSessionActorStorageOwner(
    { ...database, storePath: database.path },
    authority,
  );
  if (!captured) {
    throw new Error("Session cleanup lost its memory owner selector");
  }
  const memory = captured.owner;
  const source: SessionCleanupSource = {
    database,
    memoryIncarnation: memory?.identity.incarnation ?? null,
  };
  if (
    options.source &&
    (options.source.database.path !== database.path ||
      options.source.database.agentId !== database.agentId ||
      options.source.memoryIncarnation !== source.memoryIncarnation)
  ) {
    throw new Error("Session cleanup changed its memory owner");
  }
  const assertCurrent = () => {
    captured.authority.assertCurrent();
    memory?.assertCurrent();
  };
  return consume({
    source,
    resolved: { ...database, sessionKey: "", ownerStorePath: target.storePath },
    assertCurrent,
    read: async (fixMissing = false) => {
      assertCurrent();
      const entries = memory?.listSessionEntries(captured.authority) ?? [];
      const store = Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
      const missing: SessionCleanupReadResult["missing"] = [];
      if (fixMissing && memory) {
        // Synchronous reads share the captured owner's state without interleaved mutations.
        for (const { sessionKey, entry } of entries) {
          if (shouldPreserveSessionCleanupEntry(sessionKey, entry)) {
            continue;
          }
          const hasMessages = memory.readStorage(
            sessionKey,
            { type: "session.history.message-presence", input: { sessionId: entry.sessionId } },
            captured.authority,
          );
          if (hasMessages === false) {
            missing.push({
              sessionKey,
              expectedEntry: entry,
              archiveRemovedTranscript: true,
              requiresMissingTranscript: true,
            });
          }
        }
      }
      return { kind: "session-cleanup", store, missing };
    },
  });
}
