import { vi } from "vitest";
import type { PluginServicesHandle } from "../plugins/services.js";

export const postAttachMocks = vi.hoisted(() => {
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
