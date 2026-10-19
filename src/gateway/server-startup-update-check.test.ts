import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { applyRemoteModelCatalogUpdate } from "../agents/prepared-model-runtime.js";
import { currentUpdateCheckLifecycle } from "../infra/update-check-lifecycle.js";
import * as startupInstall from "../infra/update-install-status.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import * as workAdmission from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDeferredGatewayUpdateCheck } from "./server-startup-update-check.js";

const mocks = vi.hoisted(() => ({
  startGatewayUpdateChecks:
    vi.fn<typeof import("../infra/update-startup.js").startGatewayUpdateChecks>(),
  startUpdateRunWatcher: vi.fn<typeof import("./update-run-watcher.js").startUpdateRunWatcher>(),
}));

vi.mock("../infra/update-startup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-startup.js")>()),
  startGatewayUpdateChecks: mocks.startGatewayUpdateChecks,
}));

vi.mock("./update-run-watcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-run-watcher.js")>()),
  startUpdateRunWatcher: mocks.startUpdateRunWatcher,
}));

vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.js")>()),
  applyRemoteModelCatalogUpdate: vi.fn(),
}));

type UpdateCheckStartupParams = Parameters<typeof createDeferredGatewayUpdateCheck>[0];
type Initialization = Awaited<ReturnType<typeof startupInstall.resolveStartupInstallStatus>>;
const initialized: Initialization = {
  root: null,
  status: { root: null, installKind: "unknown", packageManager: "unknown" },
  installReceipt: null,
};

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
const owners = new Set<ReturnType<typeof createDeferredGatewayUpdateCheck>>();

beforeEach(async () => {
  workAdmission.resetGatewayWorkAdmission();
  scheduler = createTestGatewayScheduler();
  state = await createOpenClawTestState({ label: "gateway-update-check" });
  // Keep cold partial-mock loading outside the factory-readiness assertion window.
  await import("../infra/update-startup.js");
  vi.spyOn(startupInstall, "resolveStartupInstallStatus").mockResolvedValue(initialized);
  mocks.startGatewayUpdateChecks.mockReset();
  mocks.startUpdateRunWatcher
    .mockReset()
    .mockImplementation(
      (await vi.importActual<typeof import("./update-run-watcher.js")>("./update-run-watcher.js"))
        .startUpdateRunWatcher,
    );
});

afterEach(async () => {
  try {
    await Promise.all([...owners].map((owner) => owner.stop()));
    await scheduler.stop();
  } finally {
    owners.clear();
    workAdmission.resetGatewayWorkAdmission();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
    vi.restoreAllMocks();
  }
});

async function startUpdateCheck(overrides: Partial<UpdateCheckStartupParams> = {}, start = true) {
  const owner = createDeferredGatewayUpdateCheck({
    scheduler,
    loadUpdateChecks: async () =>
      (await import("../infra/update-startup.js")).startGatewayUpdateChecks,
    getConfig: () => ({}),
    getPluginRegistry: () => undefined,
    log: { info: vi.fn(), warn: vi.fn() },
    isNixMode: false,
    broadcastToConnIds: vi.fn(),
    getClientConnIds: () => new Set(),
    ...overrides,
  });
  owners.add(owner);
  if (start) {
    owner.start();
  }
  return owner;
}

async function waitForGatewayTestState(assertion: () => void | Promise<void>) {
  await vi.waitFor(assertion, { interval: 1 });
}

it("owns RPC update work when autonomous checks never start", async () => {
  const owner = await startUpdateCheck({}, false);
  const lifecycle = currentUpdateCheckLifecycle();
  const entered = createDeferred();
  const cleanup = createDeferred();
  const cancelled = createDeferred();
  const work = lifecycle.run(async (signal) => {
    signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    entered.resolve();
    await cleanup.promise;
  });
  await entered.promise;

  expect(scheduler.nextWakeAtMs).toBeNull();
  const stopped = vi.fn();
  const stopping = owner.stop().then(stopped);
  try {
    await cancelled.promise;
    expect(stopped).not.toHaveBeenCalled();
    expect(mocks.startGatewayUpdateChecks).not.toHaveBeenCalled();
  } finally {
    cleanup.resolve();
    await Promise.all([work, stopping]);
  }
  expect(stopped).toHaveBeenCalledOnce();
  expect(scheduler.nextWakeAtMs).toBeNull();
});

it.each(["background", "early manual"])(
  "scopes %s update broadcasts to read-capable operator clients",
  async (source) => {
    const clients = (
      [
        ["pairing", "operator", "operator.pairing"],
        ["node", "node", "node.read"],
        ["operator-read", "operator", "operator.read"],
      ] as const
    ).map(([connId, role, scope]) => ({ connId, connect: { role, scopes: [scope] } }));
    const broadcastToConnIds = vi.fn();
    const getClientConnIds: UpdateCheckStartupParams["getClientConnIds"] = (filter) =>
      new Set(
        clients
          .filter((client) => !filter || filter(client as never))
          .map((client) => client.connId),
      );
    const startGatewayUpdateChecks = mocks.startGatewayUpdateChecks;

    const ready = createDeferred();
    const result = await startUpdateCheck({
      ...(source === "early manual" ? { waitForPostReadyWork: () => ready.promise } : {}),
      broadcastToConnIds,
      getClientConnIds,
    });
    if (source === "background") {
      await waitForGatewayTestState(() => expect(startGatewayUpdateChecks).toHaveBeenCalledOnce());
    } else {
      expect(startGatewayUpdateChecks).not.toHaveBeenCalled();
    }

    const updateCheckParams =
      source === "background"
        ? startGatewayUpdateChecks.mock.calls[0]![0]
        : currentUpdateCheckLifecycle();
    const publicUpdate = {
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev" as const,
    };
    const gitTarget = {
      currentSha: "1111111111111111111111111111111111111111",
      upstreamRef: "origin/main",
      upstreamSha: "2222222222222222222222222222222222222222",
      commitsBehind: 1,
      commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
    };
    const updateAvailable = { ...publicUpdate, ...gitTarget };
    const schedule = {
      channel: "dev" as const,
      autoEnabled: true,
      install: { kind: "git" as const },
      target: { kind: "git" as const, ...gitTarget },
    };

    updateCheckParams.onUpdateAvailableChange?.(updateAvailable);
    updateCheckParams.onUpdateScheduleChange?.(schedule);

    const broadcast = (payload: unknown, ids: string[]) => [
      "update.available",
      payload,
      new Set(ids),
      { dropIfSlow: true },
    ];
    const publicBroadcast = broadcast({ updateAvailable: publicUpdate }, ["pairing", "node"]);
    expect(broadcastToConnIds.mock.calls).toEqual([
      broadcast({ updateAvailable }, ["operator-read"]),
      publicBroadcast,
      broadcast({ updateAvailable, schedule }, ["operator-read"]),
      publicBroadcast,
    ]);
    await result.stop();
    ready.resolve();
    broadcastToConnIds.mockClear();
    updateCheckParams.onUpdateAvailableChange?.(updateAvailable);
    updateCheckParams.onUpdateScheduleChange?.(schedule);
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  },
);

it.each(["lazy import", "initialization"])(
  "fences and joins a pending %s on close",
  async (phase) => {
    const loading = createDeferred();
    const loadingEntered = vi.fn();
    const updateStartup = await vi.importActual<typeof import("../infra/update-startup.js")>(
      "../infra/update-startup.js",
    );
    if (phase === "lazy import") {
      // Hold the actual lazy import without replacing the canonical lifecycle.
      vi.doMock("../infra/update-startup.js", async () => {
        loadingEntered();
        await loading.promise;
        return { ...updateStartup, startGatewayUpdateChecks: mocks.startGatewayUpdateChecks };
      });
    }
    const initializing = createDeferred<AbortSignal>();
    const cleanup = createDeferred();
    vi.mocked(startupInstall.resolveStartupInstallStatus).mockImplementation(async (_, signal) => {
      initializing.resolve(signal);
      await cleanup.promise;
      signal.throwIfAborted();
      return initialized;
    });
    const result = await startUpdateCheck();
    const stopped = vi.fn();
    let stopping: Promise<void> | undefined;
    try {
      if (phase === "initialization") {
        await initializing.promise;
      } else {
        await waitForGatewayTestState(() => expect(loadingEntered).toHaveBeenCalledOnce());
      }
      stopping = result.stop().then(stopped);
      expect(currentUpdateCheckLifecycle().signal.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).not.toHaveBeenCalled();
      if (phase === "lazy import") {
        expect(startupInstall.resolveStartupInstallStatus).not.toHaveBeenCalled();
        loading.resolve();
      } else {
        expect((await initializing.promise).aborted).toBe(true);
        await nextTurn();
        expect(stopped).not.toHaveBeenCalled();
        cleanup.resolve();
      }
      await stopping;
      expect(stopped).toHaveBeenCalledOnce();
      expect(mocks.startGatewayUpdateChecks).not.toHaveBeenCalled();
      expect(scheduler.nextWakeAtMs).toBeNull();
    } finally {
      loading.resolve();
      cleanup.resolve();
      try {
        await (stopping ?? result.stop());
      } finally {
        if (phase === "lazy import") {
          // Preserve the captured singleton namespace when releasing the import.
          vi.doMock("../infra/update-startup.js", () => ({
            ...updateStartup,
            startGatewayUpdateChecks: mocks.startGatewayUpdateChecks,
          }));
        }
      }
    }
  },
);

it("cancels startup waiting for suspended root admission before joining shutdown", async ({
  signal,
}) => {
  const waiting = createDeferred();
  const admit = workAdmission.runWithGatewayIndependentRootWorkAdmission;
  vi.spyOn(workAdmission, "runWithGatewayIndependentRootWorkAdmission").mockImplementation(
    function observe<T>(run: () => Promise<T>, origin?: string, admissionSignal?: AbortSignal) {
      const operation = admit(run, origin, admissionSignal);
      waiting.resolve();
      return operation;
    },
  );
  const suspension = workAdmission.tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension).not.toBeNull();
  const owner = await startUpdateCheck();
  try {
    await withinTest(waiting.promise, signal);
    expect(mocks.startGatewayUpdateChecks).not.toHaveBeenCalled();
    await withinTest(owner.stop(), signal);
    expect(currentUpdateCheckLifecycle().signal.aborted).toBe(true);
    expect(mocks.startGatewayUpdateChecks).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBeNull();
  } finally {
    suspension?.rollback();
    await owner.stop();
  }
});

it("joins update notices before releasing the update-check shutdown owner", async () => {
  const notices = createDeferred();
  const stopWatcher = vi.fn(() => notices.promise);
  mocks.startUpdateRunWatcher.mockReturnValue({ stop: stopWatcher });
  const result = await startUpdateCheck();
  const stopped = vi.fn();
  const stopping = result.stop().then(stopped);
  try {
    expect(stopWatcher).toHaveBeenCalledOnce();
    expect(currentUpdateCheckLifecycle().signal.aborted).toBe(true);
    await nextTurn();
    expect(stopped).not.toHaveBeenCalled();
    notices.resolve();
    await stopping;
    expect(stopped).toHaveBeenCalledOnce();
  } finally {
    notices.resolve();
    await stopping;
  }
});

it("warns once when initialization records unavailable Git facts", async () => {
  const warned = createDeferred();
  const warn = vi.fn(() => warned.resolve());
  vi.mocked(startupInstall.resolveStartupInstallStatus).mockResolvedValue({
    ...initialized,
    status: {
      ...initialized.status,
      error: { status: "failed", message: "Git discovery timed out", timeoutMs: 120_000 },
    },
  });
  const owner = await startUpdateCheck({ log: { info: vi.fn(), warn } });
  await warned.promise;
  await owner.stop();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "gateway update status failed to initialize: Error: Git discovery timed out",
  );
});

it("adopts scheduled remote catalogs inside the live Gateway registry scope", async () => {
  // Rebuilds must borrow this registry's existing plugin instances.
  const gatewayRegistry = createEmptyPluginRegistry();
  let adoptedIn: unknown;
  vi.mocked(applyRemoteModelCatalogUpdate).mockImplementation(async () => {
    adoptedIn = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
    return "published";
  });
  let applyRemoteCatalogUpdate: ((signal: AbortSignal) => Promise<unknown>) | undefined;
  mocks.startGatewayUpdateChecks.mockImplementation((params) => {
    applyRemoteCatalogUpdate = params.applyRemoteCatalogUpdate;
  });
  await startUpdateCheck({ getPluginRegistry: () => gatewayRegistry });
  await waitForGatewayTestState(() => expect(applyRemoteCatalogUpdate).toBeDefined());

  await expect(applyRemoteCatalogUpdate!(new AbortController().signal)).resolves.toBe("published");
  expect(adoptedIn).toBe(gatewayRegistry);
});
