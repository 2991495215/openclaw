import "../config/sessions/session-entry-patch-delivery.test-support.js";
import path from "node:path";
import { beforeEach, onTestFinished, vi } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayStoredSessionTarget } from "../config/sessions/combined-store-model-sources.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryRows,
  readExactSessionEntryRow,
  writeSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import * as observerModel from "./session-observer-model.js";
import type { SessionObserverPersistDigest } from "./session-observer-model.js";
import * as observerReads from "./session-observer-read.js";
import { createSessionObserver } from "./session-observer.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

// Keep mock registration in the early side-effect import, ahead of native consumers.
const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");

const cfg = {
  gateway: { controlUi: { sessionObserver: true } },
  agents: { defaults: { utilityModel: "openai/gpt-test" } },
} satisfies OpenClawConfig;

let eventSequence = 0;

export type PersistDigestParams = Parameters<SessionObserverPersistDigest>[0];

const nativeRead = observerReads.captureSessionObserverRead;
const nativePersist = observerModel.defaultPersistDigest;
let nativeState: OpenClawTestState;
let harnessSequence = 0;
const nativeIo = new Set<Promise<unknown>>();
const harnesses = new Set<ReturnType<typeof createHarness>>();
const persisters = new Map<string, ReturnType<typeof vi.fn<typeof nativePersist>>>();

function trackNativeIo<T>(run: () => Promise<T>): Promise<T> {
  const result = run();
  nativeIo.add(result);
  const settled = () => nativeIo.delete(result);
  void result.then(settled, settled);
  return result;
}

beforeEach(async () => {
  nativeState = await createOpenClawTestState({ scenario: "minimal", label: "observer" });
  vi.spyOn(observerReads, "captureSessionObserverRead").mockImplementation((...args) => {
    const reader = nativeRead(...args);
    return {
      ...reader,
      withRead: (consume) => trackNativeIo(() => reader.withRead(consume)),
      persist: (params) => trackNativeIo(() => reader.persist(params)),
    };
  });
  vi.spyOn(observerModel, "defaultPersistDigest").mockImplementation((params) =>
    trackNativeIo(() => {
      const persist = params.storePath && persisters.get(path.resolve(params.storePath));
      return (persist || nativePersist)(params);
    }),
  );
  onTestFinished(async () => {
    try {
      for (const harness of harnesses) {
        await harness.observer.disposeAsync();
        await harness.releaseNative();
      }
    } finally {
      harnesses.clear();
      persisters.clear();
      await nativeState.cleanup();
    }
  });
});

export function resetSessionObserverEventSequence(): void {
  eventSequence = 0;
}

export function event(params: {
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  stream: string;
  data: Record<string, unknown>;
}): AgentEventPayload {
  eventSequence += 1;
  return {
    runId: params.runId ?? "run-1",
    sessionKey: params.sessionKey ?? "agent:main:session-1",
    agentId: params.agentId ?? "main",
    seq: eventSequence,
    ts: Date.now(),
    stream: params.stream,
    data: params.data,
  };
}

export function modelMessage(
  value: Record<string, unknown>,
): Awaited<ReturnType<typeof observerModel.defaultCompleteModel>> {
  return {
    text: JSON.stringify(value),
    provider: "openai",
    model: "gpt-test",
    owner: { kind: "harness", id: "openclaw" },
  };
}

export function preparedModel(): Awaited<ReturnType<typeof observerModel.defaultPrepareModel>> {
  return {
    config: cfg,
    provider: "openai",
    model: "gpt-test",
    authProfileId: undefined,
    outputTextPolicy: "strict-visible",
    thinkLevel: "off",
    agentId: "main",
    agentDir: "/tmp/agent",
  };
}

export function persistedLiveDigest(
  overrides: Partial<SessionObserverDigest> = {},
): SessionObserverDigest {
  return {
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    revision: 7,
    updatedAt: 1_000,
    headline: "Still working",
    assessment: "The run is making progress.",
    health: "on-track",
    planProgress: { completed: 1, total: 3 },
    ...overrides,
  };
}

export async function flushObserver(): Promise<void> {
  // Model fixtures can deliberately remain pending. Only join real native I/O.
  for (;;) {
    for (let index = 0; index < 12; index += 1) {
      await Promise.resolve();
    }
    if (nativeIo.size === 0) {
      return;
    }
    await Promise.allSettled(nativeIo);
  }
}

export function createHarness(options?: {
  subscribe?: boolean;
  broadSubscribe?: boolean;
  visible?: boolean;
  completeModel?: ReturnType<typeof vi.fn<typeof observerModel.defaultCompleteModel>>;
  prepareModel?: ReturnType<typeof vi.fn<typeof observerModel.defaultPrepareModel>>;
  initialEntry?: SessionEntry;
  config?: OpenClawConfig;
}) {
  const config: OpenClawConfig = options?.config ?? structuredClone(cfg);
  config.session = {
    ...config.session,
    store:
      config.session?.store ?? nativeState.path(`harness-${++harnessSequence}`, "{agentId}.sqlite"),
  };
  const env = { ...process.env };
  const databases = new Map<string, ReturnType<typeof openOpenClawAgentDatabase>>();
  const executions: ReturnType<typeof captureOpenClawAgentDatabaseExecution>[] = [];
  const targets = new Map<string, GatewayStoredSessionTarget>();
  const rows = createSessionRowProjectionFixture({
    cfg: config,
    store: {},
    targetsBySessionKey: targets,
  });
  const persistDigest = vi.fn(nativePersist);
  const databaseFor = (agentId: string) => {
    const storePath = resolveUnsuffixedSqliteTargetFromSessionStorePath(
      resolveSessionStorePathCore(config.session?.store, { agentId, env }),
    ).path;
    let database = databases.get(storePath);
    if (!database) {
      database = openOpenClawAgentDatabase({ agentId, path: storePath, env });
      databases.set(storePath, database);
      // Keep native execution alive until this harness has joined its observer work.
      executions.push(captureOpenClawAgentDatabaseExecution({ agentId, path: storePath, env }));
      persisters.set(path.resolve(storePath), persistDigest);
    }
    return database;
  };
  const projectionKey = (sessionKey: string, agentId: string) =>
    sessionKey.startsWith("agent:") ? sessionKey : `agent:${agentId}:${sessionKey}`;
  const publishRow = (sessionKey: string, agentId: string, database = databaseFor(agentId)) => {
    const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
    const key = projectionKey(sessionKey, agentId);
    targets.set(key, {
      agentId,
      storeKey: sessionKey,
      storeTarget: { agentId, storePath: database.path },
      entry,
      readSourceEntry: (sourceKey) => readExactSessionEntryRow(database, sourceKey)?.entry,
      resolveSourceKey: (sourceKey) => sourceKey,
    });
    rows.setEntry(key, entry);
  };
  const setSession = (
    entry: SessionEntry | undefined,
    sessionKey = "agent:main:session-1",
    agentId = "main",
  ) => {
    const database = databaseFor(agentId);
    if (entry) {
      writeSessionEntry(database, sessionKey, entry);
    } else {
      runOpenClawAgentWriteTransaction((current) => deleteSessionEntryRows(current, sessionKey), {
        agentId,
        path: database.path,
        env,
      });
    }
    publishRow(sessionKey, agentId);
  };
  setSession(options?.initialEntry ?? { sessionId: "session-id", updatedAt: 0 });
  const stopRows = sessionChanges.subscribe((change) => {
    if (
      "sessionKey" in change &&
      change.agentId &&
      change.storePath &&
      databases.has(change.storePath)
    ) {
      publishRow(change.sessionKey, change.agentId, databases.get(change.storePath)!);
    }
  });
  const subscribers = createSessionMessageSubscriberRegistry();
  const sessionEventSubscribers = createSessionEventSubscriberRegistry();
  if (options?.subscribe !== false) {
    subscribers.subscribe("conn-1", "agent:main:session-1")?.commit();
  }
  if (options?.broadSubscribe) {
    sessionEventSubscribers.subscribe("conn-1");
  }
  const prepareModel = options?.prepareModel ?? vi.fn(async () => preparedModel());
  const completeModel =
    options?.completeModel ??
    vi.fn(async () =>
      modelMessage({
        headline: "Reviewing the implementation",
        assessment: "The work is progressing steadily.",
        health: "on-track",
      }),
    );
  const broadcastToConnIds = vi.fn();
  const prepareSpy = vi
    .spyOn(observerModel, "defaultPrepareModel")
    .mockImplementation(prepareModel);
  const completeSpy = vi
    .spyOn(observerModel, "defaultCompleteModel")
    .mockImplementation(completeModel);
  const observer = createSessionObserver({
    getConfig: () => config,
    subscribers,
    sessionEventSubscribers,
    broadcastToConnIds,
    getSessionRowProjection: () => rows,
  });
  // Restore native exports; only this observer retains the rearmed spies.
  prepareSpy.mockRestore();
  prepareSpy.mockImplementation(prepareModel);
  completeSpy.mockRestore();
  completeSpy.mockImplementation(completeModel);
  if ((options?.subscribe !== false || options?.broadSubscribe) && options?.visible !== false) {
    declareObserverVisibility(observer);
  }
  const harness = {
    observer,
    setSession,
    readSession: (sessionKey = "agent:main:session-1", agentId = "main") => {
      const storePath = resolveUnsuffixedSqliteTargetFromSessionStorePath(
        resolveSessionStorePathCore(config.session?.store, { agentId, env }),
      ).path;
      const database = databases.get(storePath);
      return database && readExactSessionEntryRow(database, sessionKey)?.entry;
    },
    delivery: (agentId = "main") =>
      getSessionEntryPatchDelivery({
        agentId,
        path: databaseFor(agentId).path,
        env,
      }),
    persistNative: nativePersist,
    async releaseNative() {
      stopRows();
      rows.dispose();
      await Promise.all(executions.map((execution) => execution.release()));
    },
    subscribers,
    sessionEventSubscribers,
    prepareModel,
    completeModel,
    broadcastToConnIds,
    persistDigest,
  };
  harnesses.add(harness);
  return harness;
}

export function declareObserverVisibility(
  observer: ReturnType<typeof createSessionObserver>,
  connId = "conn-1",
): void {
  observer.setConnectionVisibility(connId, true);
}

export async function startAndAddToolNotes(
  observer: ReturnType<typeof createSessionObserver>,
  params: { runId?: string; sessionKey?: string; count?: number } = {},
): Promise<void> {
  const runId = params.runId ?? "run-1";
  const sessionKey = params.sessionKey ?? "agent:main:session-1";
  await observer.handleEventAsync(
    event({ runId, sessionKey, stream: "lifecycle", data: { phase: "start" } }),
  );
  for (let index = 0; index < (params.count ?? 3); index += 1) {
    await observer.handleEventAsync(
      event({
        runId,
        sessionKey,
        stream: "tool",
        data: { phase: "start", name: "read", args: { path: `src/file-${index}.ts` } },
      }),
    );
  }
}
