import { resolveExistingAgentSessionStoreTargetsSync } from "../config/sessions/targets-discovery.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import {
  createMentionProjection,
  expireMentionItems,
  reconcileMentionProfiles,
  serializeMentionSource,
  type InboxState,
} from "./mention-inbox-projection.js";
import { readMentionStoreSnapshot, writeMentionStoreChanges } from "./mention-inbox-store.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import { resolveNativeGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";

/** Released SDK methods retain synchronous reads and transaction completion. */
export function readNativeMentionTarget(
  cfg: OpenClawConfig,
  sessionKey: string,
  agentId?: string,
): SessionSharingTarget | null {
  if (isIncognitoSessionKey(sessionKey)) {
    return null;
  }
  const target = resolveNativeGatewaySessionStoreTargetWithStore({
    cfg,
    key: sessionKey,
    agentId,
    clone: false,
    projection: "list",
    readConsistency: "latest",
    exactRead: true,
    resolveExistingTargets: (id, excludeStorePath) =>
      resolveExistingAgentSessionStoreTargetsSync(cfg, id, { excludeStorePath }),
  });
  const match = findCanonicalStoreMatch(target.store, target.storeKeys);
  return match
    ? {
        agentId: target.agentId,
        canonicalKey: target.canonicalKey,
        entry: match.entry,
        storeKey: match.key,
        storeKeys: target.storeKeys,
        storePath: target.storePath,
        readSource: target.capturedReadSource,
      }
    : null;
}

// Released 2026.9.8 SDK calls stay synchronous until the next Plugin SDK major.
export function mutateNativeMentionSnapshot(
  context: OpenClawStateWorkerContext,
  params: {
    now: () => number;
    canonicalProfileId: (id: string) => string;
    apply: (draft: InboxState) => void;
    publish: (draft: InboxState) => void;
    notify: () => void;
  },
): InboxState {
  context.admission.assertCurrent();
  return runWithSqliteWorkerStateContext(context, () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const snapshot = readMentionStoreSnapshot(-1, db);
        if (!snapshot) {
          throw new Error("Mention snapshot is unavailable inside its transaction");
        }
        const draft = createMentionProjection(snapshot);
        expireMentionItems(draft, params.now());
        reconcileMentionProfiles(draft, readUserProfileVersion(), params.canonicalProfileId);
        params.apply(draft);
        const changes = new Map(
          [...draft.dirtySources].map((key) => {
            const source = draft.processed.get(key);
            return [key, source ? serializeMentionSource(source) : undefined] as const;
          }),
        );
        draft.head = writeMentionStoreChanges(db, draft.head, changes);
        draft.dirtySources.clear();
        stageSqliteTransactionState(db, {
          stage: () => {},
          rollback: () => {},
          commit: () => params.publish(draft),
          prepareObservers: params.notify,
        });
        return draft;
      },
      { path: context.admission.databasePath, env: context.environment },
      { operationLabel: "mentions.sdk.write" },
    ),
  );
}
