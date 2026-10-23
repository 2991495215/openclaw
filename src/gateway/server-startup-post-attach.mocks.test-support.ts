import { vi } from "vitest";
import type { PluginServicesHandle } from "../plugins/services.js";

const postAttachMocks = vi.hoisted(() => {
  const startPluginServices = vi.fn<typeof import("../plugins/services.js").startPluginServices>(
    async (params) => {
      const handle: PluginServicesHandle = { reload: async () => {}, stop: async () => {} };
      params.onHandle?.(handle);
      return handle;
    },
  );
  const startGmailWatcherWithLogs = vi.fn(async () => {});
  const commitInternalHooks = vi.fn(() => true);
  const prepareInternalHooks = vi.fn(async () => ({ loadedCount: 0, commit: commitInternalHooks }));
  const hasInternalHookListeners = vi.fn(() => false);
  const startupHookEvent = { type: "gateway", action: "startup", sessionKey: "gateway:startup" };
  const createInternalHookEvent = vi.fn(() => startupHookEvent);
  const triggerInternalHook = vi.fn(async () => {});
  const updateCheck = {
    initialize: vi.fn(async () => ({
      root: null,
      status: { root: null, installKind: "unknown" as const, packageManager: "unknown" as const },
      installReceipt: null,
    })),
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const createGatewayUpdateCheck = vi.fn(() => updateCheck);
  const logGatewayStartup = vi.fn();
  const createRecoveryProgress = (settled = Promise.resolve(), initial = settled) => ({
    initial,
    pending: new Map<string, Promise<void>>(),
    settled,
  });
  const activateSubagentRegistry = vi.fn(() => createRecoveryProgress());
  const recoverExecExitNotifications = vi.fn(() => createRecoveryProgress());
  const recoverSessionSendDeliveries = vi.fn(() => createRecoveryProgress());
  const markStartupOrphanedMainSessionsForRecovery = vi.fn(async () => ({ marked: 0, skipped: 0 }));
  const scheduleRestartAbortedMainSessionRecovery = vi.fn();
  const getAcpRuntimeBackend = vi.fn<(id?: string) => unknown>(() => null);
  const reconcilePendingSessionIdentities = vi.fn(async () => ({
    checked: 0,
    resolved: 0,
    failed: 0,
  }));
  const isCliProvider = vi.fn(() => false);
  const resolveConfiguredModelRef = vi.fn(() => ({
    provider: "openai",
    model: "gpt-5.4",
  }));
  const resolveHooksGmailModel = vi.fn<() => { provider: string; model: string } | null>(
    () => null,
  );
  const loadFullModelCatalog = vi.fn(async () => {
    throw new Error("full model catalog should not materialize");
  });
  const loadModelCatalog = vi.fn(async (_options?: unknown): Promise<unknown> => ({}));
  const getModelRefStatus = vi.fn(() => ({
    key: "openai/gpt-5.4",
    allowed: true,
    inCatalog: true,
  }));
  const prepareModelRuntimeSnapshot = vi.fn(async () => ({}));
  const refreshPreparedModelRuntimeSnapshots = vi.fn<
    typeof import("../agents/prepared-model-runtime.js").refreshPreparedModelRuntimeSnapshots
  >(async () => {});
  const prewarmConfigDrivenReplyRuntime = vi.fn(async () => {});
  const scheduleGatewayHandlerPrewarm = vi.fn(() => ({ stop: vi.fn() }));
  return {
    startPluginServices,
    startGmailWatcherWithLogs,
    prepareInternalHooks,
    commitInternalHooks,
    hasInternalHookListeners,
    startupHookEvent,
    createInternalHookEvent,
    triggerInternalHook,
    updateCheck,
    createGatewayUpdateCheck,
    logGatewayStartup,
    activateSubagentRegistry,
    recoverExecExitNotifications,
    recoverSessionSendDeliveries,
    createRecoveryProgress,
    markStartupOrphanedMainSessionsForRecovery,
    scheduleRestartAbortedMainSessionRecovery,
    getAcpRuntimeBackend,
    reconcilePendingSessionIdentities,
    isCliProvider,
    resolveConfiguredModelRef,
    resolveHooksGmailModel,
    loadFullModelCatalog,
    loadModelCatalog,
    getModelRefStatus,
    prepareModelRuntimeSnapshot,
    refreshPreparedModelRuntimeSnapshots,
    prewarmConfigDrivenReplyRuntime,
    scheduleGatewayHandlerPrewarm,
  };
});

export { postAttachMocks };

vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({
  activateSubagentRegistry: postAttachMocks.activateSubagentRegistry,
}));

// mock-isolation: Startup orders recovery owners; their scanners have dedicated tests.
vi.mock("../agents/bash-tools.exec-notify.js", () => ({
  recoverExecExitNotifications: postAttachMocks.recoverExecExitNotifications,
}));

vi.mock("./session-send-recovery.js", () => ({
  recoverSessionSendDeliveries: postAttachMocks.recoverSessionSendDeliveries,
}));

vi.mock("../agents/main-session-recovery/main-session-restart-recovery.js", () => ({
  scheduleRestartAbortedMainSessionRecovery:
    postAttachMocks.scheduleRestartAbortedMainSessionRecovery,
}));

vi.mock("../agents/main-session-recovery/main-session-restart-recovery-marking.js", () => ({
  markStartupOrphanedMainSessionsForRecovery:
    postAttachMocks.markStartupOrphanedMainSessionsForRecovery,
}));

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return {
    ...actual,
    get STATE_DIR() {
      return actual.resolveStateDir();
    },
    get CONFIG_PATH() {
      return actual.resolveConfigPath();
    },
    resolveGatewayPort: vi.fn(() => 18789),
  };
});

vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: postAttachMocks.startGmailWatcherWithLogs,
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: postAttachMocks.createInternalHookEvent,
  hasInternalHookListeners: postAttachMocks.hasInternalHookListeners,
  triggerInternalHook: postAttachMocks.triggerInternalHook,
}));

vi.mock("../hooks/loader.js", () => ({
  prepareInternalHooks: postAttachMocks.prepareInternalHooks,
}));

vi.mock("../plugins/services.js", () => ({
  startPluginServices: postAttachMocks.startPluginServices,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: vi.fn(() => ({
    reconcilePendingSessionIdentities: postAttachMocks.reconcilePendingSessionIdentities,
  })),
}));

vi.mock("../acp/control-plane/manager.lifecycle.js", () => ({
  disposeAcpSessionManagerInstance: vi.fn(async () => undefined),
}));

vi.mock("../acp/runtime/registry.js", () => ({
  getAcpRuntimeBackend: postAttachMocks.getAcpRuntimeBackend,
}));

vi.mock("./server-startup-log.js", () => ({
  logGatewayStartup: postAttachMocks.logGatewayStartup,
}));

vi.mock("../infra/update-startup.js", () => ({
  createGatewayUpdateCheck: postAttachMocks.createGatewayUpdateCheck,
}));

// mock-isolation: Config publication owns the current-config producer, not external auth discovery.
vi.mock("./server-startup-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-startup-model-runtime.js")>();
  return {
    ...actual,
    hydrateConfiguredExternalCliAuth: async ({ getConfig }) => getConfig(),
  } satisfies typeof actual;
});

// mock-isolation: Sidecar scheduling does not own catalog or native-runtime preparation.
vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogOwnerSnapshot: async (options: unknown) => ({
    modelCatalog: { entries: await postAttachMocks.loadModelCatalog(options) },
  }),
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: postAttachMocks.getModelRefStatus,
  isCliProvider: postAttachMocks.isCliProvider,
  resolveConfiguredModelRef: postAttachMocks.resolveConfiguredModelRef,
  resolveHooksGmailModel: postAttachMocks.resolveHooksGmailModel,
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  publishPreparedModelRuntimeSnapshot: postAttachMocks.prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots: postAttachMocks.refreshPreparedModelRuntimeSnapshots,
}));

vi.mock("../auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: vi.fn(),
  prewarmConfigDrivenReplyRuntime: postAttachMocks.prewarmConfigDrivenReplyRuntime,
}));

// mock-isolation: Startup owns the import, not WebSocket request execution.
vi.mock("./server/ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: vi.fn(),
}));

// mock-isolation: Startup orchestration does not run independent background preparation.
vi.mock("./server-startup-handler-prewarm.js", () => ({
  scheduleGatewayPrewarm: () => [postAttachMocks.scheduleGatewayHandlerPrewarm()],
}));
