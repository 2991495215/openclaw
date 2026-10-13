import type { Static } from "typebox";
import { Type } from "typebox";
import { SESSION_AGENT_ATTENTION_ICON_IDS } from "../session-agent-status.js";
import { closedObject } from "./closed-object.js";
import {
  GatewayAgentRuntimeSchema,
  GatewayContextWindowOptionSchema,
  GatewayThinkingLevelOptionSchema,
} from "./model-runtime-options.js";
import { PluginJsonValueSchema } from "./plugins.js";
import { NonEmptyString } from "./primitives.js";
import { SessionClassificationSchema, SessionPeerKindSchema } from "./session-classification.js";
import {
  SESSION_EXPANDED_PARTICIPANT_LIMIT,
  SESSION_PARTICIPANT_LIMIT,
  SessionParticipantSchema,
  SessionParticipantIdentitySchema,
} from "./session-participant.js";
import { SessionPlacementSchema, SessionPlacementMoveSchema } from "./session-placement.js";
import { SessionActivitySummarySchema } from "./sessions-activity-summary.js";
import {
  SessionCommunicationPolicySchema,
  EffectiveSessionCommunicationPolicySchema,
} from "./sessions-communication.js";
import { SessionGoalSchema } from "./sessions-goal.js";
import { SessionObserverDigestSchema } from "./sessions-observer.js";
import { SessionProviderReviewProjectionSchema } from "./sessions-provider-review.js";
import { SessionSharingRoleSchema, SessionVisibilitySchema } from "./sessions-sharing-values.js";

export const SessionPermissionModeSchema = Type.Union([
  Type.Literal("read-only"),
  Type.Literal("guarded"),
  Type.Literal("workspace"),
  Type.Literal("full"),
]);

export const SessionRepositorySourceSchema = closedObject({
  url: Type.String({ minLength: 1, maxLength: 2048 }),
  ref: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});

export const SessionRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("interrupted"),
  Type.Literal("killed"),
  Type.Literal("timeout"),
]);

export const SessionEntryArchiveReasonSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("active-session-cap"),
  Type.Literal("age-retention"),
  Type.Literal("stale-dashboard"),
  Type.Literal("restart-recovery"),
]);

export const SessionToolOverridesSchema = closedObject({
  mcpServers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Boolean())),
  mcpToolsDeny: Type.Optional(
    Type.Record(Type.String({ minLength: 1 }), Type.Array(NonEmptyString)),
  ),
  skills: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Boolean())),
  webSearch: Type.Optional(Type.Boolean()),
});

/** Projected actor that caused a session node to be created. */
export const SessionCreatedActorSchema = closedObject({
  type: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
  id: Type.Optional(NonEmptyString),
  label: Type.Optional(NonEmptyString),
  /** Durable profile avatar route; absent for actors without a stored profile avatar. */
  avatarUrl: Type.Optional(NonEmptyString),
  /** Display identity is separate from the actor fields used by ownership policy. */
  identity: Type.Optional(SessionParticipantIdentitySchema),
});

/** Mutable responsibility for one session; actor display data is projected at read time. */
export const SessionOwnerSchema = closedObject({
  actor: SessionCreatedActorSchema,
  assignedBy: Type.Optional(SessionCreatedActorSchema),
  assignedAt: Type.Optional(Type.Number({ minimum: 0 })),
});

const SessionSwarmSummarySchema = closedObject({
  groups: Type.Array(
    closedObject({
      groupId: NonEmptyString,
      createdAt: Type.Number({ minimum: 0 }),
      children: Type.Optional(
        Type.Array(
          closedObject({
            sessionKey: NonEmptyString,
            status: Type.Union([
              Type.Literal("queued"),
              Type.Literal("running"),
              Type.Literal("done"),
              Type.Literal("failed"),
            ]),
          }),
          { maxItems: 64 },
        ),
      ),
      queued: Type.Integer({ minimum: 0 }),
      running: Type.Integer({ minimum: 0 }),
      done: Type.Integer({ minimum: 0 }),
      failed: Type.Integer({ minimum: 0 }),
    }),
    { maxItems: 5 },
  ),
  otherActiveGroups: Type.Integer({ minimum: 0 }),
});

/** Stable Gateway session row fields; mutation envelopes may add null tombstones. */
export const SessionRowSchema = Type.Object(
  {
    key: Type.String(),
    /** Fields outside the requested projection must not clear a client's full-row cache. */
    rowMode: Type.Optional(
      Type.Union([
        Type.Literal("compact"),
        Type.Literal("dashboard"),
        Type.Literal("sidebar"),
        Type.Literal("fields"),
      ]),
    ),
    /** Identifies the covered fields in the response or subscription rowProjection. */
    rowProjectionId: Type.Optional(NonEmptyString),
    /** Response-local indexes into the list's sharedFacts; expand before merging rows. */
    sharedFacts: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
    sessionId: Type.Optional(Type.String()),
    /** Incarnation revision for invalidating session-scoped client caches after resets. */
    lifecycleRevision: Type.Optional(NonEmptyString),
    /** Opaque saved model-selection inputs, unaffected by activity or display updates. */
    sessionModelRevision: Type.Optional(NonEmptyString),
    incognito: Type.Optional(Type.Literal(true)),
    kind: Type.Union([
      Type.Literal("direct"),
      Type.Literal("group"),
      Type.Literal("global"),
      Type.Literal("unknown"),
    ]),
    label: Type.Optional(Type.String()),
    autoLabel: Type.Optional(Type.String()),
    icon: Type.Optional(Type.String()),
    /** Named sidebar tint from SESSION_COLOR_IDS; clients map names to theme hues. */
    color: Type.Optional(Type.String()),
    channelAvatarUrl: Type.Optional(NonEmptyString),
    boardFace: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("dashboard")])),
    /** Prepared dashboard membership fact shared by list and change-event rows. */
    hasBoard: Type.Optional(Type.Boolean()),
    /** Shared dashboard default; absent means split. */
    boardPresentation: Type.Optional(Type.Union([Type.Literal("split"), Type.Literal("expanded")])),
    displayName: Type.Optional(Type.String()),
    derivedTitle: Type.Optional(Type.String()),
    lastMessagePreview: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    /** Stable non-sensitive facts derived from the canonical session route. */
    classification: Type.Optional(SessionClassificationSchema),
    agentId: Type.Optional(NonEmptyString),
    accountId: Type.Optional(NonEmptyString),
    peerKind: Type.Optional(SessionPeerKindSchema),
    isMain: Type.Optional(Type.Boolean()),
    isBackground: Type.Optional(Type.Boolean()),
    /** Conversation owned by a plugin dock rather than ordinary session discovery. */
    isDock: Type.Optional(Type.Boolean()),
    chatType: Type.Optional(
      Type.Union([Type.Literal("direct"), Type.Literal("group"), Type.Literal("channel")]),
    ),
    activitySummary: Type.Optional(SessionActivitySummarySchema),
    updatedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    /** Gateway sampling time, retained when a read reuses a cached projection. */
    snapshotAt: Type.Optional(Type.Number()),
    /** Connection-scoped presentation identity on full event ancestor rows. */
    ancestorRevision: Type.Optional(NonEmptyString),
    /** Personal list preference for the authenticated viewer; not session visibility. */
    hiddenFromInvolvingMe: Type.Optional(Type.Boolean()),
    archived: Type.Optional(Type.Boolean()),
    archivedAt: Type.Optional(Type.Number()),
    archivedBy: Type.Optional(SessionCreatedActorSchema),
    archiveReason: Type.Optional(SessionEntryArchiveReasonSchema),
    pinned: Type.Optional(Type.Boolean()),
    sidebarRoot: Type.Optional(Type.Boolean()),
    pinnedAt: Type.Optional(Type.Number()),
    snoozedUntil: Type.Optional(Type.Number()),
    snoozedAt: Type.Optional(Type.Number()),
    unread: Type.Optional(Type.Boolean()),
    lastReadAt: Type.Optional(Type.Number()),
    markedUnreadAt: Type.Optional(Type.Number()),
    lastActivityAt: Type.Optional(Type.Number()),
    lastInteractionAt: Type.Optional(Type.Number()),
    status: Type.Optional(SessionRunStatusSchema),
    lastRunError: Type.Optional(Type.String()),
    providerReview: Type.Optional(SessionProviderReviewProjectionSchema),
    /** Exact run that produced the latest terminal lifecycle projection. */
    lastRunId: Type.Optional(NonEmptyString),
    restartRecoveryStatus: Type.Optional(Type.Literal("tombstoned")),
    activeLeafEntryId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnedBy: Type.Optional(Type.String()),
    parentSessionKey: Type.Optional(Type.String()),
    parentSessionId: Type.Optional(Type.String()),
    controlOwnerSessionKey: Type.Optional(Type.String()),
    /** Retained owners used by spawnedBy filtering at snapshotAt; empty retires child membership. */
    childOwnerSessionKeys: Type.Optional(Type.Array(NonEmptyString, { maxItems: 2 })),
    childSessions: Type.Optional(Type.Array(Type.String())),
    forkedFromParent: Type.Optional(Type.Boolean()),
    spawnDepth: Type.Optional(Type.Number()),
    subagentRole: Type.Optional(Type.Union([Type.Literal("orchestrator"), Type.Literal("leaf")])),
    subagentControlScope: Type.Optional(
      Type.Union([Type.Literal("children"), Type.Literal("none")]),
    ),
    swarmGroupId: Type.Optional(Type.String()),
    /** Requester-owned execution counts; never child content or parent synthesis status. */
    swarm: Type.Optional(SessionSwarmSummarySchema),
    worktree: Type.Optional(
      Type.Object({
        id: Type.String(),
        branch: Type.String(),
        repoRoot: Type.String(),
      }),
    ),
    repositoryWorkspaceId: Type.Optional(NonEmptyString),
    repository: Type.Optional(
      closedObject({
        ...SessionRepositorySourceSchema.properties,
        branch: NonEmptyString,
      }),
    ),
    execNode: Type.Optional(Type.String()),
    execCwd: Type.Optional(Type.String()),
    spawnedWorkspaceDir: Type.Optional(Type.String()),
    spawnedCwd: Type.Optional(Type.String()),
    /** Persisted project registry association, distinct from a cloud repository workspace. */
    projectId: Type.Optional(Type.String()),
    /** Persisted task cwd or spawned workspace; no filesystem resolution is implied. */
    workspaceDir: Type.Optional(Type.String()),
    permissionMode: Type.Optional(SessionPermissionModeSchema),
    communication: Type.Optional(SessionCommunicationPolicySchema),
    effectiveCommunication: Type.Optional(EffectiveSessionCommunicationPolicySchema),
    /** Authorized per-chat containment opt-out; omission follows configured sandbox policy. */
    sandboxMode: Type.Optional(Type.Literal("off")),
    /** Administrator consent to the exact external runtime's own permissions for this incarnation. */
    nativeRuntimeConsent: Type.Optional(NonEmptyString),
    permissionModePending: Type.Optional(Type.Boolean()),
    sessionRoot: Type.Optional(Type.String()),
    createdVia: Type.Optional(
      Type.Union([
        Type.Literal("operator"),
        Type.Literal("spawn"),
        Type.Literal("channel"),
        Type.Literal("cron"),
        Type.Literal("talk"),
        Type.Literal("run"),
        Type.Literal("plugin"),
        Type.Literal("internal"),
      ]),
    ),
    /** Immutable presentation surface; independent of creation provenance. */
    createdSurface: Type.Optional(Type.Literal("plugin-dock")),
    createdActor: Type.Optional(SessionCreatedActorSchema),
    owner: Type.Optional(SessionOwnerSchema),
    participants: Type.Optional(
      Type.Array(SessionParticipantSchema, { maxItems: SESSION_PARTICIPANT_LIMIT }),
    ),
    expandedParticipants: Type.Optional(
      Type.Array(SessionParticipantSchema, { maxItems: SESSION_EXPANDED_PARTICIPANT_LIMIT }),
    ),
    participantCount: Type.Optional(Type.Integer({ minimum: 0 })),
    visibility: Type.Optional(SessionVisibilitySchema),
    sharingRole: Type.Optional(SessionSharingRoleSchema),
    /** Recipient-local send admission; null explicitly clears a previous restriction. */
    sendDisabledReason: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    createdAt: Type.Optional(Type.Number()),
    forkSource: Type.Optional(
      Type.Object({
        sessionKey: Type.String(),
        sessionId: Type.String(),
        entryId: Type.Optional(Type.String()),
      }),
    ),
    previousSessionId: Type.Optional(Type.String()),
    inputTokens: Type.Optional(Type.Number()),
    outputTokens: Type.Optional(Type.Number()),
    totalTokens: Type.Optional(Type.Number()),
    totalTokensFresh: Type.Optional(Type.Boolean()),
    contextTokens: Type.Optional(Type.Number()),
    estimatedCostUsd: Type.Optional(Type.Number()),
    model: Type.Optional(Type.String()),
    modelProvider: Type.Optional(Type.String()),
    /** Runtime model serving this session while it differs from the selected model. */
    activeModel: Type.Optional(Type.String()),
    activeModelProvider: Type.Optional(Type.String()),
    /** Effective override provenance; null means configured default, omission means not projected. */
    modelOverrideSource: Type.Optional(
      Type.Union([
        Type.Literal("user"),
        Type.Literal("auto"),
        Type.Literal("inherited"),
        Type.Null(),
      ]),
    ),
    toolOverrides: Type.Optional(SessionToolOverridesSchema),
    category: Type.Optional(Type.String()),
    subject: Type.Optional(Type.String()),
    groupChannel: Type.Optional(Type.String()),
    space: Type.Optional(Type.String()),
    origin: Type.Optional(
      closedObject({
        label: Type.Optional(Type.String()),
        provider: Type.Optional(Type.String()),
        surface: Type.Optional(Type.String()),
        chatType: Type.Optional(
          Type.Union([Type.Literal("direct"), Type.Literal("group"), Type.Literal("channel")]),
        ),
        from: Type.Optional(Type.String()),
        to: Type.Optional(Type.String()),
        nativeChannelId: Type.Optional(Type.String()),
        nativeDirectUserId: Type.Optional(Type.String()),
        accountId: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
      }),
    ),
    agentStatus: Type.Optional(
      closedObject({
        note: Type.String(),
        expiresAt: Type.Number(),
        attention: Type.Optional(Type.Enum(SESSION_AGENT_ATTENTION_ICON_IDS)),
      }),
    ),
    observerDigest: Type.Optional(
      Type.Pick(SessionObserverDigestSchema, [
        "agentId",
        "runId",
        "headline",
        "health",
        "updatedAt",
        "revision",
      ]),
    ),
    placement: Type.Optional(SessionPlacementSchema),
    placementMove: Type.Optional(SessionPlacementMoveSchema),
    systemSent: Type.Optional(Type.Boolean()),
    abortedLastRun: Type.Optional(Type.Boolean()),
    thinkingLevel: Type.Optional(Type.String()),
    contextWindow: Type.Optional(Type.String()),
    contextWindows: Type.Optional(Type.Array(GatewayContextWindowOptionSchema)),
    contextWindowDefault: Type.Optional(Type.String()),
    thinkingLevels: Type.Optional(Type.Array(GatewayThinkingLevelOptionSchema)),
    thinkingOptions: Type.Optional(Type.Array(Type.String())),
    thinkingDefault: Type.Optional(Type.String()),
    fastMode: Type.Optional(
      Type.Union([Type.Boolean(), Type.Literal("auto"), Type.Literal("ultrafast")]),
    ),
    effectiveFastMode: Type.Optional(
      Type.Union([Type.Boolean(), Type.Literal("auto"), Type.Literal("ultrafast")]),
    ),
    effectiveFastModeSource: Type.Optional(
      Type.Union([
        Type.Literal("session"),
        Type.Literal("agent"),
        Type.Literal("config"),
        Type.Literal("default"),
      ]),
    ),
    fastAutoOnSeconds: Type.Optional(Type.Number()),
    verboseLevel: Type.Optional(Type.String()),
    traceLevel: Type.Optional(Type.String()),
    reasoningLevel: Type.Optional(Type.String()),
    elevatedLevel: Type.Optional(Type.String()),
    sendPolicy: Type.Optional(Type.Union([Type.Literal("allow"), Type.Literal("deny")])),
    goal: Type.Optional(SessionGoalSchema),
    hasActiveRun: Type.Optional(Type.Boolean()),
    activeRunIds: Type.Optional(Type.Array(Type.String())),
    hasAutomation: Type.Optional(Type.Boolean()),
    subagentRunState: Type.Optional(
      Type.Union([Type.Literal("active"), Type.Literal("interrupted"), Type.Literal("historical")]),
    ),
    hasActiveSubagentRun: Type.Optional(Type.Boolean()),
    startedAt: Type.Optional(Type.Number()),
    endedAt: Type.Optional(Type.Number()),
    runtimeMs: Type.Optional(Type.Number()),
    responseUsage: Type.Optional(
      Type.Union([
        Type.Literal("on"),
        Type.Literal("off"),
        Type.Literal("tokens"),
        Type.Literal("full"),
      ]),
    ),
    effectiveResponseUsage: Type.Optional(
      Type.Union([
        Type.Literal("on"),
        Type.Literal("off"),
        Type.Literal("tokens"),
        Type.Literal("full"),
      ]),
    ),
    queueMode: Type.Optional(
      Type.Union([
        Type.Literal("steer"),
        Type.Literal("followup"),
        Type.Literal("collect"),
        Type.Literal("interrupt"),
      ]),
    ),
    effectiveQueueMode: Type.Optional(
      Type.Union([
        Type.Literal("steer"),
        Type.Literal("followup"),
        Type.Literal("collect"),
        Type.Literal("interrupt"),
      ]),
    ),
    modelSelectionLocked: Type.Optional(Type.Boolean()),
    runtimeSelectionLocked: Type.Optional(Type.Boolean()),
    agentRuntime: Type.Optional(GatewayAgentRuntimeSchema),
    contextBudgetStatus: Type.Optional(
      closedObject({
        schemaVersion: Type.Literal(1),
        source: Type.Literal("pre-prompt-estimate"),
        updatedAt: Type.Number(),
        provider: Type.String(),
        model: Type.String(),
        route: Type.Union([
          Type.Literal("fits"),
          Type.Literal("compact_only"),
          Type.Literal("truncate_tool_results_only"),
          Type.Literal("compact_then_truncate"),
        ]),
        shouldCompact: Type.Boolean(),
        estimatedPromptTokens: Type.Number(),
        contextTokenBudget: Type.Number(),
        promptBudgetBeforeReserve: Type.Number(),
        reserveTokens: Type.Number(),
        effectiveReserveTokens: Type.Number(),
        remainingPromptBudgetTokens: Type.Number(),
        overflowTokens: Type.Number(),
        toolResultReducibleChars: Type.Number(),
        messageCount: Type.Number(),
        unwindowedMessageCount: Type.Number(),
        sessionId: Type.Optional(Type.String()),
      }),
    ),
    deliveryContext: Type.Optional(
      closedObject({
        channel: Type.Optional(Type.String()),
        to: Type.Optional(Type.String()),
        accountId: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
        deliveryIntent: Type.Optional(
          closedObject({
            id: Type.String(),
            kind: Type.Literal("outbound_queue"),
            queuePolicy: Type.Optional(
              Type.Union([Type.Literal("required"), Type.Literal("best_effort")]),
            ),
          }),
        ),
      }),
    ),
    lastChannel: Type.Optional(Type.String()),
    lastTo: Type.Optional(Type.String()),
    lastAccountId: Type.Optional(Type.String()),
    lastThreadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    pluginExtensions: Type.Optional(
      Type.Array(
        closedObject({
          pluginId: Type.String(),
          namespace: Type.String(),
          value: PluginJsonValueSchema,
        }),
      ),
    ),
  },
  { additionalProperties: true },
);

/** Unchanged presentation of an ancestor previously delivered on this connection. */
export const SessionAncestorRefSchema = closedObject({
  key: NonEmptyString,
  sessionId: Type.Optional(Type.String()),
  agentId: Type.Optional(NonEmptyString),
  revision: NonEmptyString,
  snapshotAt: Type.Number(),
});

/** Complete visible ancestor coverage shared by sessions.changed and session.message. */
export const SessionEventAncestorsSchema = closedObject({
  ancestorSessions: Type.Array(SessionRowSchema, { maxItems: 64 }),
  ancestorSessionRefs: Type.Optional(Type.Array(SessionAncestorRefSchema, { maxItems: 64 })),
});

export type SessionCreatedActor = Static<typeof SessionCreatedActorSchema>;
export type SessionPermissionMode = Static<typeof SessionPermissionModeSchema>;
export type SessionOwner = Static<typeof SessionOwnerSchema>;
export type SessionRunStatus = Static<typeof SessionRunStatusSchema>;
export type SessionToolOverrides = Static<typeof SessionToolOverridesSchema>;
export type SessionRow = Static<typeof SessionRowSchema>;
export type SessionAncestorRef = Static<typeof SessionAncestorRefSchema>;
export type SessionEventAncestors = Static<typeof SessionEventAncestorsSchema>;
export type SessionEntryArchiveReason = Static<typeof SessionEntryArchiveReasonSchema>;
