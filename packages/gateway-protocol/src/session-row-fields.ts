import { Type } from "typebox";
import { closedObject } from "./schema/closed-object.js";
import { NonEmptyString } from "./schema/primitives.js";
import type { SessionRowSchema, SessionRow } from "./schema/sessions-row.js";

export type SessionRowField = keyof typeof SessionRowSchema.properties;

/** Closed wire vocabulary; keep UI preset imports independent of the runtime row schema. */
export const SESSION_ROW_FIELDS = [
  "key",
  "rowMode",
  "rowProjectionId",
  "sharedFacts",
  "sessionId",
  "lifecycleRevision",
  "sessionModelRevision",
  "incognito",
  "kind",
  "label",
  "autoLabel",
  "icon",
  "color",
  "channelAvatarUrl",
  "boardFace",
  "hasBoard",
  "boardPresentation",
  "displayName",
  "derivedTitle",
  "lastMessagePreview",
  "channel",
  "classification",
  "agentId",
  "accountId",
  "peerKind",
  "isMain",
  "isBackground",
  "isDock",
  "chatType",
  "activitySummary",
  "updatedAt",
  "snapshotAt",
  "ancestorRevision",
  "hiddenFromInvolvingMe",
  "archived",
  "archivedAt",
  "archivedBy",
  "archiveReason",
  "pinned",
  "sidebarRoot",
  "pinnedAt",
  "snoozedUntil",
  "snoozedAt",
  "unread",
  "lastReadAt",
  "markedUnreadAt",
  "lastActivityAt",
  "lastInteractionAt",
  "status",
  "lastRunError",
  "providerReview",
  "lastRunId",
  "restartRecoveryStatus",
  "activeLeafEntryId",
  "spawnedBy",
  "parentSessionKey",
  "parentSessionId",
  "controlOwnerSessionKey",
  "childOwnerSessionKeys",
  "childSessions",
  "forkedFromParent",
  "spawnDepth",
  "subagentRole",
  "subagentControlScope",
  "swarmGroupId",
  "swarm",
  "worktree",
  "repositoryWorkspaceId",
  "repository",
  "execNode",
  "execCwd",
  "spawnedWorkspaceDir",
  "spawnedCwd",
  "projectId",
  "workspaceDir",
  "permissionMode",
  "communication",
  "effectiveCommunication",
  "sandboxMode",
  "nativeRuntimeConsent",
  "permissionModePending",
  "sessionRoot",
  "createdVia",
  "createdSurface",
  "createdActor",
  "owner",
  "participants",
  "expandedParticipants",
  "participantCount",
  "visibility",
  "sharingRole",
  "sendDisabledReason",
  "createdAt",
  "forkSource",
  "previousSessionId",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "totalTokensFresh",
  "contextTokens",
  "estimatedCostUsd",
  "model",
  "modelProvider",
  "activeModel",
  "activeModelProvider",
  "modelOverrideSource",
  "toolOverrides",
  "category",
  "subject",
  "groupChannel",
  "space",
  "origin",
  "agentStatus",
  "observerDigest",
  "placement",
  "placementMove",
  "systemSent",
  "abortedLastRun",
  "thinkingLevel",
  "contextWindow",
  "contextWindows",
  "contextWindowDefault",
  "thinkingLevels",
  "thinkingOptions",
  "thinkingDefault",
  "fastMode",
  "effectiveFastMode",
  "effectiveFastModeSource",
  "fastAutoOnSeconds",
  "verboseLevel",
  "traceLevel",
  "reasoningLevel",
  "elevatedLevel",
  "sendPolicy",
  "goal",
  "hasActiveRun",
  "activeRunIds",
  "hasAutomation",
  "subagentRunState",
  "hasActiveSubagentRun",
  "startedAt",
  "endedAt",
  "runtimeMs",
  "responseUsage",
  "effectiveResponseUsage",
  "queueMode",
  "effectiveQueueMode",
  "modelSelectionLocked",
  "runtimeSelectionLocked",
  "agentRuntime",
  "contextBudgetStatus",
  "deliveryContext",
  "lastChannel",
  "lastTo",
  "lastAccountId",
  "lastThreadId",
  "pluginExtensions",
] as const satisfies readonly SessionRowField[];

const sessionRowFieldsComplete: Exclude<
  SessionRowField,
  (typeof SESSION_ROW_FIELDS)[number]
> extends never
  ? true
  : false = true;
void sessionRowFieldsComplete;

export const SESSION_ROW_BASE_FIELDS = [
  "key",
  "kind",
  "updatedAt",
  "sessionId",
  "lifecycleRevision",
  "rowMode",
  "rowProjectionId",
] as const satisfies readonly SessionRowField[];

export const SessionRowModeSchema = Type.Union([
  Type.Literal("compact"),
  Type.Literal("dashboard"),
  Type.Literal("sidebar"),
]);
export const SessionRowFieldSchema = Type.Enum(SESSION_ROW_FIELDS);
export const SessionRowFieldsSchema = Type.Array(SessionRowFieldSchema, {
  minItems: 1,
  maxItems: SESSION_ROW_FIELDS.length,
  uniqueItems: true,
});
export const SessionRowProjectionSchema = closedObject({
  id: NonEmptyString,
  fields: SessionRowFieldsSchema,
});

export type SessionRowProjection = { id: string; fields: SessionRowField[] };
export type ProjectedSessionRow<Fields extends readonly SessionRowField[]> = Pick<
  SessionRow,
  Fields[number] | (typeof SESSION_ROW_BASE_FIELDS)[number]
>;

/** Compact list omissions are unknown detail facts, never deletion receipts. */
const compactDetailFields: readonly SessionRowField[] = [
  "contextWindows",
  "contextWindowDefault",
  "thinkingLevels",
  "thinkingOptions",
  "thinkingDefault",
  "toolOverrides",
  "providerReview",
  "nativeRuntimeConsent",
  "contextBudgetStatus",
  "agentRuntime",
  "pluginExtensions",
] as const;

/** Gallery presentation and the facts needed to reconcile its held membership. */
const dashboardFields = [
  "key",
  "rowMode",
  "sessionId",
  "lifecycleRevision",
  "kind",
  "agentId",
  "label",
  "displayName",
  "derivedTitle",
  "lastMessagePreview",
  "accountId",
  "updatedAt",
  "snapshotAt",
  "status",
  "createdActor",
  "owner",
  "hasBoard",
  "boardFace",
  "archived",
  "pinned",
  "pinnedAt",
  "isDock",
  "sidebarRoot",
  "spawnedBy",
  "controlOwnerSessionKey",
  "parentSessionKey",
  "childSessions",
  "childOwnerSessionKeys",
  "isMain",
  "worktree",
  "repository",
  "execNode",
] as const satisfies readonly SessionRowField[];

/** Sidebar rendering, actions, and the receipts used by its managed list window. */
const sidebarFields = [
  ...dashboardFields,
  "incognito",
  "icon",
  "color",
  "channelAvatarUrl",
  "category",
  "channel",
  "classification",
  "chatType",
  "subject",
  "groupChannel",
  "space",
  "origin",
  "deliveryContext",
  "createdVia",
  "createdSurface",
  "createdAt",
  "participants",
  "expandedParticipants",
  "participantCount",
  "archivedBy",
  "snoozedUntil",
  "unread",
  "lastReadAt",
  "markedUnreadAt",
  "lastActivityAt",
  "lastInteractionAt",
  "hiddenFromInvolvingMe",
  "visibility",
  "sharingRole",
  "communication",
  "effectiveCommunication",
  "hasActiveRun",
  "hasActiveSubagentRun",
  "activeRunIds",
  "subagentRunState",
  "modelSelectionLocked",
  "hasAutomation",
  "agentStatus",
  "observerDigest",
  "lastRunError",
  "abortedLastRun",
  "restartRecoveryStatus",
  "startedAt",
  "endedAt",
  "runtimeMs",
  "execCwd",
  "spawnedWorkspaceDir",
  "spawnedCwd",
  "placement",
  "placementMove",
  "forkSource",
  "parentSessionId",
  "forkedFromParent",
  "spawnDepth",
  "subagentRole",
  "subagentControlScope",
  "swarmGroupId",
] as const satisfies readonly SessionRowField[];

export const SESSION_ROW_PRESETS = {
  compact: SESSION_ROW_FIELDS.filter((field) => !compactDetailFields.includes(field)),
  dashboard: dashboardFields,
  sidebar: sidebarFields,
} as const satisfies Record<string, readonly SessionRowField[]>;
export type SessionRowMode = keyof typeof SESSION_ROW_PRESETS;

export const SESSION_ROW_DETAIL_FIELDS = SESSION_ROW_FIELDS.filter(
  (field) => !SESSION_ROW_PRESETS.compact.includes(field),
);
export const SESSION_DASHBOARD_ROW_FIELDS: ReadonlySet<string> = new Set(
  SESSION_ROW_PRESETS.dashboard,
);
export const SESSION_SIDEBAR_ROW_FIELDS: ReadonlySet<string> = new Set(SESSION_ROW_PRESETS.sidebar);

/** Preset-only calls retain their existing wire shape and do not need a descriptor. */
export function resolveSessionRowProjection(params: {
  rowMode?: SessionRowMode;
  fields?: readonly SessionRowField[];
}): SessionRowProjection | undefined {
  if (!params.fields) {
    return undefined;
  }
  const selected = new Set<SessionRowField>([
    ...SESSION_ROW_BASE_FIELDS,
    ...params.fields,
    ...(params.rowMode ? SESSION_ROW_PRESETS[params.rowMode] : []),
  ]);
  const fields = SESSION_ROW_FIELDS.filter((field) => selected.has(field));
  return {
    id: `f1:${fields.map((field) => SESSION_ROW_FIELDS.indexOf(field).toString(36)).join(".")}`,
    fields,
  };
}

/** Response-local facts: no cross-request catalog or invalidation protocol. */
export function shareSessionRowFacts<T extends SessionRow>(sessions: T[]) {
  type SharedFact = { fact: Partial<T>; fields: string[]; rows: { index: number; row: T }[] };
  const candidates = new Map<string, SharedFact>();
  const rows = sessions.map((row) => ({ ...row }));
  rows.forEach((row, index) => {
    for (const [field, value] of Object.entries(row)) {
      // Keep required fields and the projection marker readable without expanding the table.
      if (
        value === undefined ||
        ["key", "kind", "updatedAt", "sessionId", "rowMode", "rowProjectionId"].includes(field)
      ) {
        continue;
      }
      const fact: Partial<T> = {};
      Object.assign(fact, { [field]: value });
      const key = JSON.stringify(fact);
      const candidate = candidates.get(key);
      if (candidate) {
        candidate.rows.push({ index, row });
      } else {
        candidates.set(key, { fact, fields: [field], rows: [{ index, row }] });
      }
    }
  });
  // Facts with the same recipients share one reference, including common scalar defaults.
  const groups = new Map<string, SharedFact>();
  for (const candidate of candidates.values()) {
    if (candidate.rows.length < 2) {
      continue;
    }
    const key = candidate.rows.map(({ index }) => index).join(",");
    const group = groups.get(key);
    if (group) {
      Object.assign(group.fact, candidate.fact);
      group.fields.push(...candidate.fields);
    } else {
      groups.set(key, candidate);
    }
  }
  const sharedFacts: Partial<T>[] = [];
  for (const group of groups.values()) {
    const reference = sharedFacts.push(group.fact) - 1;
    for (const { row } of group.rows) {
      for (const field of group.fields) {
        Reflect.deleteProperty(row, field);
      }
      (row.sharedFacts ??= []).push(reference);
    }
  }
  return { sessions: rows, sharedFacts };
}

/** Expand before any list reconciliation so the renderer only consumes normal rows. */
export function expandSessionRowFacts<T extends SessionRow>(
  sessions: T[],
  sharedFacts: Partial<T>[] | undefined,
): T[] {
  if (!sharedFacts) {
    return sessions;
  }
  return sessions.map((row) => {
    const next = { ...row };
    for (const index of row.sharedFacts ?? []) {
      Object.assign(next, sharedFacts[index]);
    }
    Object.assign(next, row);
    delete next.sharedFacts;
    return next;
  });
}
