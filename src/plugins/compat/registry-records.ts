import { ACTIVATION_HINT_COMPAT_RECORDS } from "./activation-hint-records.js";
import { AGENT_HARNESS_COMPAT_RECORDS } from "./agent-harness-records.js";
import { ASYNC_SQLITE_PREPARATION_COMPAT_RECORDS } from "./async-sqlite-preparation-records.js";
import { AUTH_ASYNC_COMPAT_RECORD } from "./auth-async-record.js";
import { BINDING_PERSISTENCE_COMPAT_RECORDS } from "./binding-persistence-records.js";
import { DEPRECATION_MARKING_COMPAT_RECORDS } from "./deprecation-marking.js";
import { MEDIA_LEGACY_PROJECTION_COMPAT_RECORD } from "./media-legacy-projection.js";
import { MEMORY_SESSION_COMPAT_RECORDS } from "./memory-session-records.js";
import { PLUGIN_SDK_PRIVATE_RUNTIME_EXPORT_COMPAT_RECORD } from "./plugin-sdk-private-runtime-export-record.js";
import { PLUGIN_SDK_REMOVED_EXPORT_RECORDS } from "./plugin-sdk-removed-export-records.js";
import {
  BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_RECORDS,
  PLUGIN_SDK_SUBPATH_RECORDS,
} from "./plugin-sdk-subpath-records.js";
import { SESSION_PERSISTENCE_COMPAT_RECORDS } from "./session-persistence-records.js";
import { SQLITE_RUNTIME_COMPAT_RECORDS } from "./sqlite-runtime-records.js";
import type { PluginCompatRecord } from "./types.js";

// Preserve the finite code union without publishing literal migration metadata through its type.
function defineCompatRecords<const Code extends string>(
  records: readonly PluginCompatRecord<Code>[],
): readonly PluginCompatRecord<Code>[] {
  return records;
}

function sdkCompatRecord<const Code extends string>(
  code: Code,
  record: Omit<PluginCompatRecord<Code>, "code" | "owner" | "status"> &
    Partial<Pick<PluginCompatRecord<Code>, "status">>,
): PluginCompatRecord<Code> {
  return { code, status: "deprecated", owner: "sdk", ...record };
}

export const PLUGIN_COMPAT_RECORDS = defineCompatRecords([
  ...PLUGIN_SDK_REMOVED_EXPORT_RECORDS,
  ...AGENT_HARNESS_COMPAT_RECORDS,
  AUTH_ASYNC_COMPAT_RECORD,
  ...ASYNC_SQLITE_PREPARATION_COMPAT_RECORDS,
  ...BINDING_PERSISTENCE_COMPAT_RECORDS,
  sdkCompatRecord("channel-pairing-sync-allowlist", {
    deprecated: "2026-10-03",
    warningStarts: "2026-10-03",
    removeAfter: "2026-12-31",
    replacement:
      "Await readChannelAllowFromStore from channel-pairing. The released synchronous reader retains its signature and native behavior through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#channel-pairing-allowlists",
    surfaces: ["openclaw/plugin-sdk/channel-pairing.readChannelAllowFromStoreSync"],
    diagnostics: [
      "TypeScript @deprecated annotation and migration documentation; bounded capability-family warnings on legacy preparation",
    ],
  }),
  sdkCompatRecord("cron-store-sync-path", {
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    removeAfter: "2026-12-31",
    replacement:
      "Await resolveCronStorePathAsync(storePath) from openclaw/plugin-sdk/cron-store-runtime. The synchronous resolveCronStorePath(storePath) retains its existing return value through 2026-12-31; removal ships in the first January 2027 stable release.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#cron-store-path-resolution",
    surfaces: ["openclaw/plugin-sdk/cron-store-runtime resolveCronStorePath"],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous cron path resolution"],
  }),
  sdkCompatRecord("mention-inbox-sync-persistence", {
    deprecated: "2026-10-03",
    warningStarts: "2026-10-03",
    removalGate: "stable-deprecation-period",
    replacement:
      "Await mentionInbox.listAsync(client, publish), mentionInbox.dismissAsync(client, ids, publish), mentionInbox.recordCommittedInputAsync(input), and mentionInbox.invalidateAsync(sessionKey). Publish list/dismiss responses synchronously inside the supplied callback. Deprecated synchronous signatures remain until an announced later ordinary stable release; list/dismiss return UNAVAILABLE, invalidate throws migration guidance, and recordCommittedInput queues the worker operation after commit.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-mention-inbox-operations",
    surfaces: [
      "GatewayRequestHandlerOptions.context.mentionInbox.list",
      "GatewayRequestHandlerOptions.context.mentionInbox.dismiss",
      "GatewayRequestHandlerOptions.context.mentionInbox.recordCommittedInput",
      "GatewayRequestHandlerOptions.context.mentionInbox.invalidate",
      "getPluginRuntimeGatewayRequestScope().context.mentionInbox",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations, explicit migration-directed rejection, and one DEP_SESSION_PERSISTENCE warning per plugin and capability family per process; unscoped callers share one SDK-level family warning",
    ],
  }),
  sdkCompatRecord("model-account-connect-sync-persistence", {
    deprecated: "2026-10-03",
    warningStarts: "2026-10-03",
    removeAfter: "2026-12-31",
    replacement:
      "Await modelAccountConnectService.listLinksAsync, linkAsync, unlinkAsync, listAsync, selectAsync, statusAsync, and cancelAsync with the existing arguments. Retain synchronous methods and their completion timing for shipped third-party contracts through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-personal-model-account-operations",
    surfaces: [
      "GatewayRequestHandlerOptions.context.modelAccountConnectService.listLinks",
      "GatewayRequestHandlerOptions.context.modelAccountConnectService.link",
      "GatewayRequestHandlerOptions.context.modelAccountConnectService.unlink",
      "GatewayRequestHandlerOptions.context.modelAccountConnectService.list",
      "GatewayRequestHandlerOptions.context.modelAccountConnectService.select",
      "GatewayRequestHandlerOptions.context.modelAccountConnectService.status",
      "GatewayRequestHandlerOptions.context.modelAccountConnectService.cancel",
      "getPluginRuntimeGatewayRequestScope().context.modelAccountConnectService",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and one DEP_SESSION_PERSISTENCE warning per plugin and capability family per process; unscoped callers share one SDK-level family warning",
    ],
  }),
  sdkCompatRecord("workspace-mutation-guard-callback", {
    deprecated: "2026-10-02",
    warningStarts: "2026-10-02",
    removeAfter: "2026-12-31",
    replacement:
      "Await database preparation before ensureAgentWorkspace and use SQL-free guard.assertHost for live authority. Internal recovery predicates run on the worker transaction connection.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#workspace-mutation-guards",
    surfaces: ["api.runtime.agent.ensureAgentWorkspace.beforePersistentApply"],
    diagnostics: [
      "@deprecated JSDoc and one DEP_WORKSPACE_MUTATION_GUARD warning per process",
      "Warning explains before-dispatch timing and deprecated but allowed synchronous OpenClaw DB access",
    ],
  }),
  ...SESSION_PERSISTENCE_COMPAT_RECORDS,
  sdkCompatRecord("skill-command-discovery-sync", {
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    removeAfter: "2026-12-31",
    replacement:
      "Await prepareSkillCommandsForAgents or prepareSkillCommandsForWorkspace. Synchronous list methods retain their array results through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-skill-command-discovery",
    surfaces: [
      "openclaw/plugin-sdk/skill-commands-runtime.listSkillCommandsForAgents",
      "openclaw/plugin-sdk/skill-commands-runtime.listSkillCommandsForWorkspace",
      "openclaw/plugin-sdk/command-auth-native.listSkillCommandsForAgents",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and one runtime warning per plugin and capability family",
    ],
  }),
  ...SQLITE_RUNTIME_COMPAT_RECORDS,
  sdkCompatRecord("native-approval-commit-guard", {
    deprecated: "2026-10-09",
    warningStarts: "2026-10-09",
    removalGate: "stable-deprecation-period",
    replacement:
      "Use host-bound api.runtime.gateway.request approval methods. Released opaque approval commit guards run at the worker precommit boundary; they cannot read uncommitted transaction state. Final effect-time authority checks remain synchronous and current.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#use-worker-owned-approval-requests",
    surfaces: ["GatewayRequestHandlerOptions.sessionMutationCommitGuard for approval methods"],
    diagnostics: ["Shared per-plugin capability-family warning on legacy callback use"],
  }),
  sdkCompatRecord("tts-preferences-sync-resolution", {
    deprecated: "2026-10-03",
    warningStarts: "2026-10-03",
    removeAfter: "2026-12-31",
    replacement:
      "Await resolveTtsPrefsPathAsync(config) for the machine-owned path. For prompt hints, await the public api.runtime.tts.buildSystemPromptHintAsync method. Bundled plugins can also await private prepareTtsPreferences and pass preparedTtsPreferences to the supported synchronous hint overload. The unprepared synchronous hint and preference-path calls remain compatible through 2026-12-31; removal ships in the first January 2027 stable release.",
    docsPath: "/plugins/sdk-migration/async-transcript-and-tts",
    surfaces: [
      "openclaw/plugin-sdk/agent-runtime resolveTtsPrefsPath",
      "openclaw/plugin-sdk/tts-runtime resolveTtsPrefsPath",
      "openclaw/plugin-sdk/tts-runtime buildTtsSystemPromptHint",
    ],
    diagnostics: [
      "Bounded DEP_PLUGIN_SDK warning for legacy path resolution and unprepared synchronous hint calls; prepared hints remain silent",
    ],
  }),
  sdkCompatRecord("agent-list-runtime-projection", {
    deprecated: "2026-10-02",
    warningStarts: "2026-10-02",
    removeAfter: "2027-01-02",
    replacement:
      "Canonical `cfg.agents.entries`, or `listAgentIds` / `resolveAgentConfig` from `openclaw/plugin-sdk/agent-runtime`",
    docsPath: "/plugins/sdk-migration/how-to-migrate#agent-roster-config",
    surfaces: ["non-enumerable runtime OpenClawConfig.agents.list projection"],
    diagnostics: ["plugin compatibility registry and migration documentation; no runtime warnings"],
  }),
  sdkCompatRecord("watched-sessions-sync-harness-context", {
    deprecated: "2026-10-03",
    warningStarts: "2026-10-03",
    removeAfter: "2026-12-31",
    replacement:
      "Await prepareWatchedSessionsHarnessContext with an assertCurrent callback bound to the current host capability. The released buildWatchedSessionsHarnessContext retains its synchronous string-or-undefined result through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#watched-session-harness-context",
    surfaces: ["openclaw/plugin-sdk/agent-harness-runtime.buildWatchedSessionsHarnessContext"],
    diagnostics: [
      "TypeScript @deprecated annotation and migration documentation; bounded capability-family warnings on legacy preparation",
    ],
  }),
  sdkCompatRecord("web-search-sync-provider-list", {
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    removeAfter: "2026-12-31",
    replacement:
      "Await runtime.webSearch.listProvidersAsync(params). The synchronous listProviders(params) retains its return shape through 2026-12-31; removal ships in the first January 2027 stable release.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#web-search-provider-lists",
    surfaces: ["PluginRuntime.webSearch.listProviders"],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous web-search provider lists"],
  }),
  sdkCompatRecord("reply-dispatch-progress-receipt-handoff", {
    deprecated: "2026-10-06",
    warningStarts: "2026-10-06",
    removalGate: "stable-deprecation-period",
    replacement:
      "Adapt editable progress cards through ReplyDispatchRuntimeInfo.adoptProgressDraft. The released receipt-based adoptProgressContinuation type is retained until an announced later ordinary stable release and explicit maintainer approval; the host never offers it, so adapters keep ordinary waiting-reply delivery.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#progress-card-handoff",
    surfaces: [
      "openclaw/plugin-sdk/reply-runtime.ReplyDispatchRuntimeInfo.adoptProgressContinuation",
    ],
    diagnostics: [
      "TypeScript @deprecated annotation and migration documentation; no runtime warnings",
    ],
  }),
  {
    code: "runtime-config-sync-load",
    status: "deprecated",
    owner: "config",
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    removeAfter: "2026-12-31",
    replacement:
      "Use readRuntimeConfig for the already prepared runtime snapshot. At a cold preparation boundary, await captureRuntimeConfigAsyncReader()() first or use its returned config. The released getRuntimeConfig keeps its synchronous cold-load behavior through 2026-12-31; removal ships in the first January 2027 stable release.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#read-prepared-runtime-config",
    surfaces: [
      "openclaw/plugin-sdk/runtime-config-snapshot.getRuntimeConfig",
      "openclaw/plugin-sdk/memory-core-host-runtime-core.getRuntimeConfig",
    ],
    diagnostics: [
      "TypeScript @deprecated annotation and one DEP_SESSION_PERSISTENCE warning per plugin and runtime-config family per process on legacy use",
    ],
  },
  sdkCompatRecord("assistant-text-phase-terminal-hint", {
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    removalGate: "stable-deprecation-period",
    replacement: "Omit textPhaseRequiresTerminal; unphased text is never retroactively classified.",
    docsPath: "/concepts/streaming#text-phases-and-final-replies",
    surfaces: ["AssistantMessage.openclawDelivery.textPhaseRequiresTerminal"],
    diagnostics: ["TypeScript @deprecated annotation; no runtime warning for the ignored field"],
  }),
  sdkCompatRecord("session-transcript-sync-view", {
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    removeAfter: "2026-12-31",
    replacement:
      "Await loadCombinedSessionStoreForGatewayAsync from openclaw/plugin-sdk/session-transcript-hit. The synchronous export retains its complete, non-incognito view through 2026-12-31; removal ships in the first January 2027 stable release.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#session-transcript-search-views",
    surfaces: ["openclaw/plugin-sdk/session-transcript-hit loadCombinedSessionStoreForGateway"],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous session transcript views"],
  }),
  PLUGIN_SDK_PRIVATE_RUNTIME_EXPORT_COMPAT_RECORD,
  {
    code: "channel-prepared-tool-policy",
    status: "deprecated",
    owner: "channel",
    deprecated: "2026-10-12",
    warningStarts: "2026-10-12",
    removalGate: "stable-deprecation-period",
    replacement:
      "Resolve current configuration through security.resolveDirectToolPolicy or groups.resolveToolPolicy using authenticated requester and conversation facts. The legacy snapshot remains execution-local to the original external request, including its queued turn; it is never requester provenance for new delegation.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#channel-prepared-tool-policy",
    surfaces: [
      "BuildChannelInboundEventContextParams.access.toolPolicy",
      "MsgContext.ConversationToolPolicy",
    ],
    diagnostics: ["DEP_CHANNEL_PREPARED_TOOL_POLICY warns once on legacy policy use"],
  },
  sdkCompatRecord("plugin-sdk-session-header-link", {
    deprecated: "2026-10-12",
    warningStarts: "2026-10-12",
    removeAfter: "2027-01-12",
    replacement:
      "Register a plugin-owned `session-header` accessory that renders its own content; the host no longer supplies session conversation-link metadata",
    docsPath: "/plugins/sdk-migration/compatibility-policy#session-header-link-helper",
    surfaces: ["openclaw/plugin-sdk/control-ui.createSessionHeaderLink"],
    diagnostics: ["TypeScript @deprecated annotation and shipped Plugin SDK surface check"],
  }),
  sdkCompatRecord("gateway-placement-sync-results", {
    deprecated: "2026-10-02",
    warningStarts: "2026-10-02",
    removalGate: "stable-deprecation-period",
    replacement:
      "Await getManyAsync, retireSessionPlacementAsync, listPendingWorkspaceResultsAsync, getWorkspaceResultReconcilingSessionIdsAsync, getAdmittedDeviceSessionCountsAsync, and deferOrphanedRequestsAsync on the Gateway context. For placement standing-grant preparation, await resolveBindingAsync, retainAsync, and validateAsync. Placement get/getMany read committed in-process receipts only; cold reads require getAsync/getManyAsync. Synchronous placement inventories and writes retain their deprecated signatures but fail with migration guidance; use listAsync, listForReconcileAsync, clearLocalTurnClaimsAfterRestartAsync, retireSessionPlacementAsync, and the result-reader replacements. Other listed surfaces follow their owner-specific migration contracts.",
    docsPath:
      "/plugins/sdk-migration/compatibility-policy#gateway-placement-and-publication-readers",
    surfaces: [
      "GatewayRequestHandlerOptions.context.workerSessionPlacementService.getMany",
      "GatewayRequestHandlerOptions.context.workerSessionPlacementService.retireSessionPlacement",
      "GatewayRequestHandlerOptions.context.workerSessionPlacementService.clearLocalTurnClaimsAfterRestart",
      "GatewayRequestHandlerOptions.context.workerPlacementDispatchService.getAdmittedDeviceSessionCounts",
      "GatewayRequestHandlerOptions.context.placementStandingGrants.resolveBinding",
      "GatewayRequestHandlerOptions.context.placementStandingGrants.retain",
      "GatewayRequestHandlerOptions.context.placementStandingGrants.validate",
      "GatewayRequestHandlerOptions.context.workerSessionPlacementService.listPendingWorkspaceResults",
      "GatewayRequestHandlerOptions.context.workerSessionPlacementService.getWorkspaceResultReconcilingSessionIds",
      "GatewayRequestHandlerOptions.context.githubPublicationService.deferOrphanedRequests",
      "getPluginRuntimeGatewayRequestScope().context",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; placement reads, retirement, and restart clearing warn once per plugin and capability family on legacy use, while GitHub orphan deferral shares the github-publication family warning",
    ],
  }),
  ...MEMORY_SESSION_COMPAT_RECORDS,
  {
    code: "channel-webhook-listener-config-inputs",
    status: "deprecated",
    owner: "config",
    deprecated: "2026-09-26",
    warningStarts: "2026-09-26",
    removalGate: "stable-deprecation-period",
    replacement:
      "Use legacyWebhook for canonical listener config. Doctor migrates stored webhookPort/webhookHost and webhook.port inputs; deprecated optional TypeScript properties preserve config producer source compatibility until an approved ordinary stable removal.",
    docsPath: "/gateway/doctor/config-migrations#channel-webhook-listeners",
    surfaces: [
      "TelegramAccountConfig.webhookPort",
      "TelegramAccountConfig.webhookHost",
      "FeishuConfig.webhookPort",
      "FeishuConfig.webhookHost",
      "FeishuAccountConfig.webhookPort",
      "FeishuAccountConfig.webhookHost",
      "MSTeamsWebhookConfig.port",
      "NextcloudTalkAccountConfig.webhookPort",
      "NextcloudTalkAccountConfig.webhookHost",
    ],
    diagnostics: ["TypeScript @deprecated annotations and plugin-owned Doctor migration"],
  },
  {
    code: "conversation-binding-sync-mutations",
    status: "deprecated",
    owner: "channel",
    deprecated: "2026-09-20",
    warningStarts: "2026-09-20",
    removeAfter: "2026-12-31",
    replacement:
      "Await getSessionBindingService().bind, unbind, inspectByConversationAsync, resolveByConversationAsync, touchAsync, resolveRuntimeConversationBindingRouteAsync, and the Async-suffixed thread-binding lifecycle setters. Bundled current-conversation mutations and session listings use the existing worker owner. Project prepared inspection facts with inspectRuntimeConversationBindingRoute. Legacy external adapters retain their synchronous projection contract.",
    docsPath: "/plugins/sdk-runtime/channel#awaited-conversation-binding-mutations",
    surfaces: [
      "SessionBindingService.touch",
      "SessionBindingService.resolveByConversation",
      "SessionBindingAdapter.touch",
      "SessionBindingAdapter.resolveByConversation",
      "resolveRuntimeConversationBindingRoute",
      "ChannelConversationBindingSupport.setIdleTimeoutBySessionKey",
      "ChannelConversationBindingSupport.setMaxAgeBySessionKey",
      "api.runtime.channel.threadBindings.setIdleTimeoutBySessionKey",
      "api.runtime.channel.threadBindings.setMaxAgeBySessionKey",
      "@openclaw/discord.setThreadBindingIdleTimeoutBySessionKey",
      "@openclaw/discord.setThreadBindingMaxAgeBySessionKey",
      "@openclaw/telegram.setTelegramThreadBindingIdleTimeoutBySessionKey",
      "@openclaw/telegram.setTelegramThreadBindingMaxAgeBySessionKey",
      "@openclaw/matrix.setMatrixThreadBindingIdleTimeoutBySessionKey",
      "@openclaw/matrix.setMatrixThreadBindingMaxAgeBySessionKey",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and bounded capability-family warnings on legacy binding calls",
    ],
  },
  ...PLUGIN_SDK_SUBPATH_RECORDS,
  ...BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_RECORDS,
  ...DEPRECATION_MARKING_COMPAT_RECORDS,
  MEDIA_LEGACY_PROJECTION_COMPAT_RECORD,
  sdkCompatRecord("node-workspace-sync-acquisition", {
    deprecated: "2026-09-15",
    warningStarts: "2026-09-15",
    removeAfter: "2026-12-31",
    replacement:
      "Await context.acquireManagedWorkspaceAsync(request) and release the returned lease in finally. Retain synchronous acquisition for supported external plugins through 2026-12-31; removal ships in the first January 2027 stable release.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#managed-node-workspace-acquisition",
    surfaces: ["OpenClawPluginNodeHostCommandContext.acquireManagedWorkspace"],
    diagnostics: [
      "TypeScript @deprecated annotation and bounded capability-family warning on legacy workspace acquisition",
    ],
  }),
  sdkCompatRecord("plugin-state-sync-keyed-store", {
    deprecated: "2026-09-11",
    warningStarts: "2026-09-11",
    removeAfter: "2026-12-31",
    replacement:
      "Use api.runtime.state.openKeyedStoreV2 or createPluginStateKeyedStoreV2, await data-only operations, and replace update/deleteIf closures with observe/compareAndApply. Synchronous methods retain commit-before-return through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-runtime/state-and-system#synchronous-keyed-store-migration",
    surfaces: [
      "api.runtime.state.openSyncKeyedStore",
      "PluginStateSyncKeyedStore",
      "createPluginStateSyncKeyedStore",
      "PluginStateSyncKeyedStore.register",
      "PluginStateSyncKeyedStore.registerIfAbsent",
      "PluginStateSyncKeyedStore.update",
      "PluginStateSyncKeyedStore.deleteIf",
      "PluginStateSyncKeyedStore.lookup",
      "PluginStateSyncKeyedStore.lookupMany",
      "PluginStateSyncKeyedStore.consume",
      "PluginStateSyncKeyedStore.delete",
      "PluginStateSyncKeyedStore.entries",
      "PluginStateSyncKeyedStore.count",
      "PluginStateSyncKeyedStore.clear",
      "PluginStateKeyedStore.update",
      "PluginStateKeyedStore.deleteIf",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and state-store migration documentation",
      "plugin compatibility inventory; legacy writer migrations use the shared once-per-plugin-and-capability-family warning policy",
    ],
  }),
  sdkCompatRecord("memory-read-result-statusless-success", {
    deprecated: "2026-08-19",
    warningStarts: "2026-08-19",
    removalGate: "stable-deprecation-period",
    replacement: '`MemoryReadResult` with explicit `status: "ok" | "not_found"`',
    docsPath: "/plugins/sdk-migration#memory-read-missing-results",
    surfaces: ["statusless external memory manager read results"],
    diagnostics: ["host memory-manager acquisition adapter"],
  }),
  sdkCompatRecord("context-engine-legacy-host-param-default", {
    status: "removed",
    replacement:
      "`ContextEngineInfo.acceptedHostParams` for restricted projection; omitted declarations receive full host params",
    docsPath: "/concepts/context-engine#the-contextengine-interface",
    surfaces: ["ContextEngineInfo.acceptedHostParams and undeclared-engine default projection"],
    diagnostics: ["plugin compatibility registry and context engine guide"],
  }),
  sdkCompatRecord("removed-global-api-provider-publication", {
    status: "removed",
    replacement:
      "provider plugins via `api.registerProvider(...)`; host/runtime code registers against its lifecycle-owned `ApiRegistry`",
    docsPath: "/plugins/sdk-migration#process-global-api-provider-publication",
    surfaces: [
      "openclaw/plugin-sdk/llm registerApiProvider",
      "openclaw/plugin-sdk/llm unregisterApiProviders",
    ],
    diagnostics: ["plugin SDK compatibility registry and migration guide"],
  }),
  sdkCompatRecord("legacy-deactivate-hook-alias", {
    status: "removed",
    replacement: "`gateway_stop` hook",
    docsPath: "/plugins/sdk-migration#deactivate-hook-alias",
    surfaces: ['api.on("deactivate", ...)', "plugin typed hook registration"],
    diagnostics: ["plugin compatibility registry and migration guide"],
  }),
  sdkCompatRecord("legacy-subagent-spawning-hook", {
    status: "removed",
    replacement:
      "`subagent_spawned` for post-launch observation; core session-binding adapters for thread routing",
    docsPath: "/plugins/hooks#upcoming-deprecations",
    surfaces: [
      'api.on("subagent_spawning", ...)',
      "PluginHookSubagentSpawningEvent",
      "PluginHookSubagentSpawningResult",
      "SubagentLifecycleHookRunner.runSubagentSpawning",
    ],
    diagnostics: ["plugin compatibility registry and migration guide"],
  }),
  sdkCompatRecord("removed-skill-proposal-hooks", {
    status: "removed",
    // Removal landed 2026-10-08 (#161057); the prior day was the final compatibility day.
    removeAfter: "2026-10-07",
    docsPath: "/plugins/sdk-migration/removed-surfaces#skill-workshop-proposal-hooks",
    surfaces: [
      'api.on("skill_proposal_evaluate", ...)',
      'api.on("skill_proposal_changed", ...)',
      "openclaw/plugin-sdk/plugin-entry.PluginHookSkillProposalEvaluateEvent",
      "openclaw/plugin-sdk/plugin-entry.PluginHookSkillProposalEvaluateResult",
      "openclaw/plugin-sdk/plugin-entry.PluginHookSkillProposalEvaluationOutcome",
      "openclaw/plugin-sdk/plugin-entry.PluginHookSkillProposalChangedEvent",
      "openclaw/plugin-sdk/plugin-entry.PluginHookSkillProposalKind",
      "openclaw/plugin-sdk/plugin-entry.PluginHookSkillEvaluationFinding",
      "openclaw/plugin-sdk/plugin-entry.PluginHookSkillBundleFile",
      "openclaw/plugin-sdk/plugin-entry.PluginHookSkillBundleSnapshot",
      "PluginHookSkillChangedEvent.proposal",
    ],
    diagnostics: ["plugin compatibility registry and migration guide"],
  }),
  sdkCompatRecord("hook-only-plugin-shape", {
    status: "active",
    replacement: "explicit capability registration",
    docsPath: "/plugins/sdk-migration",
    surfaces: ["plugin shape inspection", "plugins inspect", "status diagnostics"],
    diagnostics: ["plugin compatibility notice"],
  }),
  sdkCompatRecord("deprecated-memory-embedding-provider-api", {
    status: "removed",
    replacement: "`api.registerEmbeddingProvider(...)` and `contracts.embeddingProviders`",
    docsPath: "/plugins/sdk-migration#memory-embedding-provider-api",
    surfaces: [
      "api.registerMemoryEmbeddingProvider(...)",
      "contracts.memoryEmbeddingProviders",
      "openclaw/plugin-sdk/memory-core-host-engine-embeddings registerMemoryEmbeddingProvider",
      "plugin compatibility registry and migration guide",
    ],
    diagnostics: ["plugin compatibility registry and migration guide"],
  }),
  sdkCompatRecord("plugin-sdk-session-agent-resolution-aliases", {
    deprecated: "2026-08-29",
    warningStarts: "2026-08-29",
    removeAfter: "2026-11-29",
    replacement:
      "`resolveSessionAgentIdsStrict` and `resolveSessionAgentIdStrict` with an explicit agent, agent-scoped session key, prepared fallback, or persisted owner",
    docsPath: "/plugins/compatibility#session-agent-resolution-aliases",
    surfaces: [
      "openclaw/plugin-sdk/agent-scope-runtime resolveSessionAgentIds and resolveSessionAgentId",
      "openclaw/plugin-sdk/agent-runtime session-agent resolver aliases",
      "openclaw/plugin-sdk/agent-harness-runtime session-agent resolver aliases",
      "openclaw/plugin-sdk/memory-core-host-runtime-core session-agent resolver alias",
      "openclaw/plugin-sdk/memory-host-core session-agent resolver alias",
    ],
    diagnostics: ["TypeScript deprecated SDK alias annotations", "plugin compatibility registry"],
  }),
  sdkCompatRecord("agent-harness-credential-prompt-string-argument", {
    deprecated: "2026-09-09",
    warningStarts: "2026-09-09",
    removeAfter: "2026-11-30",
    replacement: "options object `{ controlToolsAvailable }`",
    docsPath: "/plugins/sdk-migration/removed-surfaces#credential-prompt-builder",
    surfaces: [
      "openclaw/plugin-sdk/agent-harness-runtime buildCredentialSafetyPrompt string argument",
    ],
    diagnostics: ["JSDoc parameter deprecation", "plugin compatibility registry"],
  }),
  sdkCompatRecord("removed-session-transcript-file-api", {
    status: "removed",
    replacement:
      "session identity (`sessionKey`/`sessionId`), `SessionTranscriptUpdate.target`, and Gateway/runtime session helpers",
    docsPath: "/plugins/sdk-migration#removed-session-and-transcript-file-apis",
    surfaces: [
      "saveSessionStore",
      "resolveSessionTranscriptPathInDir",
      "resolveAndPersistSessionFile",
      "readLatestAssistantTextFromSessionTranscript",
      "SessionTranscriptUpdate.sessionFile",
      "sessionFiles",
      "transcriptPath",
      "sessionFile",
      "plugins inspect compatibility notices",
    ],
    diagnostics: ["plugin compatibility notice"],
  }),
  {
    code: "hook.before_tool_call.terminal-block-approval",
    status: "active",
    owner: "agent-runtime",
    docsPath: "/plugins/hooks",
    surfaces: ["before_tool_call block result", "before_tool_call approval result"],
    diagnostics: ["hook runner contract check"],
  },
  {
    code: "hook.llm-observer.privacy-payload",
    status: "active",
    owner: "agent-runtime",
    docsPath: "/plugins/hooks",
    surfaces: ["llm_input", "llm_output", "agent_end", "allowConversationAccess"],
    diagnostics: ["conversation access hook contract check"],
  },
  {
    code: "api.capture.runtime-registrars",
    status: "active",
    owner: "plugin-execution",
    docsPath: "/plugins/architecture-internals",
    surfaces: [
      "createCapturedPluginRegistration",
      "capturePluginRegistration",
      "OpenClawPluginApi",
    ],
    diagnostics: ["runtime registration capture contract check"],
  },
  {
    code: "channel.runtime.envelope-config-metadata",
    status: "active",
    owner: "channel",
    docsPath: "/plugins/sdk-channel-plugins",
    surfaces: ["api.registerChannel", "channel setup metadata", "channel message envelope"],
    diagnostics: ["channel runtime contract check"],
  },
  {
    code: "whatsapp-web-inbound-flat-message-aliases",
    status: "removed",
    owner: "channel",
    replacement:
      "WhatsApp `WebInboundCallbackMessage` nested contexts: `event`, `payload`, `quote`, `group`, and `platform`",
    docsPath: "/plugins/compatibility",
    surfaces: [
      "@openclaw/whatsapp WebInboundMessage flat fields",
      "WhatsApp monitorWebInbox onMessage callback",
      "WhatsApp monitorWebChannel listenerFactory injected messages",
    ],
    diagnostics: ["plugin compatibility registry and compatibility guide"],
  },
  {
    code: "whatsapp-web-inbound-admission-top-level-fields",
    status: "removed",
    owner: "channel",
    replacement:
      "WhatsApp `WebInboundMessage.admission` fields: `conversation.id`, `accountId`, `ingress.decision`, and `conversation.kind`",
    docsPath: "/plugins/compatibility",
    surfaces: [
      "@openclaw/whatsapp WebInboundMessage top-level admission fields",
      "WhatsApp monitorWebInbox onMessage callback",
      "WhatsApp monitorWebChannel listenerFactory injected messages",
    ],
    diagnostics: ["plugin compatibility registry and compatibility guide"],
  },
  sdkCompatRecord("sdk-untrusted-context-identifier-aliases", {
    status: "removal-pending",
    deprecated: "2026-07-22",
    warningStarts: "2026-07-22",
    removeAfter: "2026-09-08",
    replacement:
      "`MsgContext.ChannelPromptContext`, `MsgContext.ChannelStructuredContext`, `ChannelStructuredContextEntry`, `SupplementalContextFacts.channelStructuredContext`, and `buildChannelMetadata`; retain the aliases until migration of published plugin readers is verified and explicit breaking-release approval is granted",
    docsPath: "/plugins/compatibility",
    surfaces: [
      "openclaw/plugin-sdk reply-runtime MsgContext.UntrustedContext and UntrustedStructuredContext",
      "openclaw/plugin-sdk reply-runtime UntrustedStructuredContextEntry",
      "openclaw/plugin-sdk channel-inbound SupplementalContextFacts.untrustedContext",
      "openclaw/plugin-sdk security-runtime buildUntrustedChannelMetadata",
    ],
    diagnostics: ["TypeScript deprecated SDK alias annotations"],
  }),
  sdkCompatRecord("channel-explicit-target-parser", {
    status: "removed",
    replacement:
      "`messaging.targetResolver` for target normalization and `messaging.resolveOutboundSessionRoute` for session/thread identity",
    docsPath: "/plugins/sdk-migration",
    surfaces: [
      "ChannelMessagingAdapter.parseExplicitTarget",
      "openclaw/plugin-sdk/channel-route ChannelRouteExplicitTarget",
      "openclaw/plugin-sdk/channel-route ChannelRouteExplicitTargetParser",
      "openclaw/plugin-sdk/channel-route resolveChannelRouteTargetWithParser",
    ],
    diagnostics: ["plugin SDK compatibility warning"],
  }),
  sdkCompatRecord("channel-messaging-targets-subpath", {
    status: "removed",
    replacement: "`openclaw/plugin-sdk/channel-targets`",
    docsPath: "/plugins/sdk-migration",
    surfaces: ["openclaw/plugin-sdk/messaging-targets"],
    diagnostics: ["plugin SDK compatibility warning"],
  }),
  {
    code: "bundled-plugin-allowlist",
    status: "active",
    owner: "config",
    replacement: "manifest-owned plugin enablement and scoped load plans",
    docsPath: "/plugins/architecture",
    surfaces: ["plugins.allow", "bundled provider startup", "plugins status"],
    diagnostics: ["plugin status report"],
  },
  {
    code: "bundled-plugin-enablement",
    status: "active",
    owner: "config",
    replacement: "manifest-owned plugin defaults and scoped load plans",
    docsPath: "/plugins/architecture",
    surfaces: ["plugins.entries", "bundled provider startup", "plugins status"],
    diagnostics: ["plugin status report"],
  },
  ...ACTIVATION_HINT_COMPAT_RECORDS,
  {
    code: "embedded-pi-agent-sdk-aliases",
    status: "removed",
    owner: "agent-runtime",
    replacement: "`runEmbeddedAgent` and `EmbeddedAgent*` SDK/runtime names",
    docsPath: "/plugins/sdk-runtime",
    surfaces: [
      "api.runtime.agent.runEmbeddedPiAgent",
      "openclaw/extension-api runEmbeddedPiAgent",
      "openclaw/plugin-sdk/agent-harness-runtime EmbeddedPi* aliases",
    ],
    diagnostics: ["plugin SDK compatibility registry"],
  },
  {
    code: "plugin-sdk-shipped-channel-setup-exports",
    status: "deprecated",
    owner: "channel",
    deprecated: "2026-07-23",
    warningStarts: "2026-07-23",
    replacement:
      "retain until supported published packages migrate to plugin-owned config schemas plus generic `openclaw/plugin-sdk/channel-config-schema` and `openclaw/plugin-sdk/setup-runtime` primitives",
    docsPath: "/plugins/sdk-migration#published-channel-setup-compatibility",
    surfaces: [
      "openclaw/plugin-sdk/bundled-channel-config-schema SlackConfigSchema",
      "openclaw/plugin-sdk/bundled-channel-config-schema DiscordConfigSchema",
      "openclaw/plugin-sdk/bundled-channel-config-schema SignalConfigSchema",
      "openclaw/plugin-sdk/bundled-channel-config-schema MSTeamsConfigSchema",
      "openclaw/plugin-sdk/setup-runtime createLegacyCompatChannelDmPolicy",
      "openclaw/plugin-sdk/setup-runtime promptLegacyChannelAllowFromForAccount",
    ],
    diagnostics: [
      "repository deprecated API usage guard for core and bundled plugins; no external runtime import warning",
    ],
  },
  {
    code: "generated-bundled-channel-config-fallback",
    status: "active",
    owner: "channel",
    replacement: "manifest registry `channelConfigs` metadata",
    docsPath: "/plugins/manifest",
    surfaces: ["generated bundled channel config metadata", "channel config validation"],
    diagnostics: ["channel config metadata fallback"],
  },
  {
    code: "setup-runtime-fallback",
    status: "active",
    owner: "setup",
    replacement: "`setup.requiresRuntime: false` with complete setup descriptors",
    docsPath: "/plugins/manifest/setup-and-auth#setup-reference",
    surfaces: ["setup-api runtime fallback", "setup.requiresRuntime omitted"],
    diagnostics: ["setup registry runtime diagnostic"],
  },
]);
