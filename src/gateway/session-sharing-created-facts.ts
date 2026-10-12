import path from "node:path";
import { readPreparedSessionEntryChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
  type SessionEntryPlaceholder,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import type { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { SessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export type PreparedSessionSourceFacts = PreparedSessionMutationFacts & {
  /** Physical source retained by the same read custody as the sharing facts. */
  sourcePath?: string;
  sourceAgentId?: string;
};

export type CommittedSessionMutationTarget = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
  lifecycleRevision?: string;
  readSource?: CapturedSessionEntryReadSource;
};

type RetainedSharingRead = ReturnType<typeof retainPreparedSessionSharingFacts>;

/** Retain one sharing row, promoting absent/idless facts only from its creator's COMMIT. */
export function createSessionSharingReceiptRead({
  selected,
  canonicalKey,
  allowMissing,
  match,
  sharing,
  sourceIdentities,
  retainedReads,
  selectedPaths,
  preparedSources,
  releases,
  getExpectedPlaceholder,
  setExpectedPlaceholder,
}: {
  selected: GatewaySessionStoreTarget;
  canonicalKey: string;
  allowMissing?: true;
  match: { entry: SessionEntry; key: string } | undefined;
  sharing: Awaited<ReturnType<typeof readSessionEntriesFromStoreInWorker>>["sharing"];
  sourceIdentities: ReadonlyMap<string, CapturedSessionEntryReadSource>;
  retainedReads: Map<string, RetainedSharingRead>;
  selectedPaths: ReadonlySet<string>;
  preparedSources: Array<{ agentId: string; path: string; identity: string; birthtime: string }>;
  releases: Array<() => void>;
  getExpectedPlaceholder: () => SessionEntryPlaceholder | undefined;
  setExpectedPlaceholder: (placeholder: SessionEntryPlaceholder | undefined) => void;
}) {
  let readFacts: () => PreparedSessionSourceFacts;
  let acknowledgedCreation: { databaseIdentity: string; sessionId: string } | undefined;
  let captureCreatedPublication = (_change: SessionRowChange): boolean => false;
  let recordCreated: ((created: CommittedSessionMutationTarget) => void) | undefined;
  if (!match) {
    if (!allowMissing) {
      throw new SessionMutationFactsUnavailableError();
    }
    const retained = sharing && retainedReads.get(`${sharing.databaseIdentity}\0${canonicalKey}`);
    setExpectedPlaceholder(retained?.readCurrent()?.placeholder);
    readFacts = () => {
      const current = retained?.readCurrent();
      if (
        (retained && !current) ||
        current?.entry ||
        current?.placeholder?.sessionId !== getExpectedPlaceholder()?.sessionId
      ) {
        throw new SessionMutationFactsUnavailableError();
      }
      return { target: null, membership: new Set<string>() };
    };
  } else {
    if (!sharing) {
      throw new SessionMutationFactsUnavailableError();
    }
    const target = {
      agentId: selected.agentId,
      canonicalKey: selected.canonicalKey,
      storePath: selected.storePath,
      readSource: sourceIdentities.get(selected.storePath),
      storeKeys: selected.storeKeys,
      entry: projectSessionSharingEntry(match.entry),
      storeKey: match.key,
    };
    const retained = retainedReads.get(`${sharing.databaseIdentity}\0${target.storeKey}`);
    if (!retained) {
      throw new SessionMutationFactsUnavailableError();
    }
    readFacts = () => {
      const current = retained.readCurrent();
      if (!current?.entry) {
        throw new SessionMutationFactsUnavailableError();
      }
      return {
        sourcePath: sharing.source.path,
        sourceAgentId: sharing.source.agentId,
        target: { ...target, entry: current.entry },
        membership: current.membership,
      };
    };
  }
  if (allowMissing && !match?.entry.sessionId) {
    // Hold the write receipt without adopting another creator's row. Only this
    // request's acknowledged COMMIT may promote its original absent/idless target.
    let pendingCreated:
      | {
          source: CapturedSessionEntryReadSource & { databaseIdentity: string };
          retained: ReturnType<typeof retainPreparedSessionSharingFacts>;
        }
      | undefined;
    captureCreatedPublication = (change) => {
      if (
        !("sessionKey" in change) ||
        !change.storePath ||
        !selectedPaths.has(path.resolve(change.storePath))
      ) {
        return false;
      }
      const published = readPreparedSessionEntryChange(change, canonicalKey);
      if (
        !published?.sharing ||
        !published.projection ||
        typeof published.source.identity !== "string" ||
        published.source.birthtime === undefined
      ) {
        return false;
      }
      const source: CapturedSessionEntryReadSource & { databaseIdentity: string } = {
        agentId: selected.agentId,
        path: published.source.filename,
        databaseIdentity: published.source.identity,
        databaseBirthtime: published.source.birthtime,
      };
      const identity = `file:${published.source.identity}`;
      const key = `${identity}\0${canonicalKey}`;
      const retained = retainPreparedSessionSharingFacts({
        databaseIdentity: identity,
        sessionKey: canonicalKey,
        entry: published.sharing,
        membership: new Set(published.projection.membership[2]),
      });
      retainedReads.get(key)?.release();
      retainedReads.set(key, retained);
      releases.push(retained.release);
      pendingCreated = { source, retained };
      if (!preparedSources.some((prepared) => prepared.path === source.path)) {
        preparedSources.push({
          agentId: source.agentId,
          path: source.path,
          identity,
          birthtime: published.source.birthtime,
        });
      }
      return true;
    };
    recordCreated = (created) => {
      const pending = pendingCreated;
      const current = pending?.retained.readCurrent();
      if (
        !pending ||
        !current?.entry ||
        created.agentId !== selected.agentId ||
        created.sessionKey !== canonicalKey ||
        created.storePath !== selected.storePath ||
        created.sessionId !== current.entry.sessionId ||
        created.lifecycleRevision !== current.entry.lifecycleRevision ||
        (created.readSource &&
          (created.readSource.databaseIdentity !== pending.source.databaseIdentity ||
            created.readSource.databaseBirthtime !== pending.source.databaseBirthtime))
      ) {
        throw new SessionMutationFactsUnavailableError();
      }
      const target = {
        agentId: selected.agentId,
        canonicalKey,
        storeKey: canonicalKey,
        storeKeys: selected.storeKeys,
        storePath: selected.storePath,
        readSource: pending.source,
      };
      readFacts = () => {
        const latest = pending.retained.readCurrent();
        if (!latest?.entry) {
          throw new SessionMutationFactsUnavailableError();
        }
        return {
          target: { ...target, entry: latest.entry },
          membership: latest.membership,
          sourcePath: pending.source.path,
          sourceAgentId: pending.source.agentId,
        };
      };
      acknowledgedCreation = {
        sessionId: created.sessionId,
        databaseIdentity: pending.source.databaseIdentity,
      };
      captureCreatedPublication = () => false;
      recordCreated = undefined;
    };
  }

  return {
    read: () => readFacts(),
    captureCreatedPublication: (change: SessionRowChange) => captureCreatedPublication(change),
    recordCreated: (created: CommittedSessionMutationTarget) => {
      if (!recordCreated) {
        return undefined;
      }
      recordCreated(created);
      return readFacts();
    },
    acknowledgesIdentityMutation: (change: SessionIdentityMutation) =>
      // The creator already installed this idless-to-id COMMIT receipt.
      Boolean(
        acknowledgedCreation &&
        !change.previous.sessionId &&
        "current" in change &&
        change.current.sessionId === acknowledgedCreation.sessionId &&
        change.databaseIdentity === acknowledgedCreation.databaseIdentity,
      ),
  };
}
