import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SessionEventOutcome } from "../auto-reply/reply/session-event-contract.js";
import type {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
  SessionEventTarget,
} from "../auto-reply/reply/session-event-handoff.js";
import type { SystemEvent } from "../infra/system-events.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  decodeSessionStateNoticeContextKey,
  enqueueSessionStateNotice,
} from "./session-state-notices.js";

const mocks = vi.hoisted(() => ({
  ownerKey: Symbol("session-state-notices-fixture"),
  pending: [] as SystemEvent[],
  nextOccurrenceId: 0,
  ownedIds: new Set<string>(),
  capture: vi.fn<typeof captureSessionEventTargetForHost>(async () => ({
    sessionId: "original",
    generation: "current",
  })),
  enqueue: vi.fn<typeof enqueueSessionEventForHost>(() => receipt("notice-turn")),
  acknowledge: vi.fn(async () => {}),
}));
// A shared worker may retain an earlier module's owner and its different queue/handoff bindings.
vi.mock("../shared/global-singleton.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/global-singleton.js")>();
  const resolve = actual.resolveGlobalSingleton;
  return {
    ...actual,
    resolveGlobalSingleton: (...[key, ...rest]: Parameters<typeof resolve>) =>
      resolve(key === Symbol.for("openclaw.sessionStateNotices") ? mocks.ownerKey : key, ...rest),
  };
});

// mock-isolation: Exercise the real notice debouncer without starting model or SQLite work.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: mocks.capture,
  combineSessionEventTargetsForHost: (targets: readonly SessionEventTarget[]) => targets[0],
  enqueueSessionEventForHost: mocks.enqueue,
  assertSessionEventTargetCurrent: vi.fn(),
}));
// mock-isolation: Fake-time coalescing must not borrow another suite's live store resolver.
vi.mock("../infra/system-event-ownership.js", () => ({ isSystemEventStoreCurrent: () => true }));
// mock-isolation: Keep pending occurrences local so these timer cases cannot drain shared queues.
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEventEntry: (text: string, options: Partial<SystemEvent>) => {
    if (
      mocks.pending.some(
        (event) =>
          event.text === text &&
          event.contextKey === options.contextKey &&
          event.sessionStorePath === options.sessionStorePath,
      )
    ) {
      return null;
    }
    const occurrence: SystemEvent = {
      text,
      ...options,
      id: String(mocks.nextOccurrenceId++),
      ts: 1,
    };
    mocks.pending.push(occurrence);
    return occurrence;
  },
  peekSystemEventEntries: () => [...mocks.pending],
  isSystemEventTurnOwned: (_key: string, event: SystemEvent) => mocks.ownedIds.has(event.id ?? ""),
}));
// mock-isolation: Observe adoption without opening cursor writers; the permissions suite covers native custody.
vi.mock("./session-state-notice-acknowledgment.js", () => ({
  acknowledgeSessionStateNoticesInWorker: mocks.acknowledge,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.capture.mockReset().mockResolvedValue({ sessionId: "original", generation: "current" });
  mocks.pending.length = 0;
  mocks.nextOccurrenceId = 0;
  mocks.ownedIds.clear();
});
afterEach(async () => {
  try {
    await drainGlobalSingletonLifecycleState("restart");
  } finally {
    vi.useRealTimers();
  }
});

type Notice = Parameters<typeof enqueueSessionStateNotice>[0];
function enqueue(targetSessionKey: string, options: Partial<Notice> = {}) {
  enqueueSessionStateNotice({
    watcherSessionKey: "agent:main:main",
    targetSessionKey,
    lastSeenSequence: 1,
    ...options,
  });
}

const done: SessionEventOutcome = { status: "completed", executionStarted: true, delivered: false };
function receipt(id: string, settled = Promise.resolve(done)) {
  return { id, accepted: Promise.resolve({ ok: true as const }), cancel: () => true, settled };
}

it.each([
  ["session-state:efbbbf6167656e743a6d61696e", "\uFEFFagent:main"],
  ["session-state:ff", undefined], // Strict UTF-8 prevents corrupt watcher-cursor collisions.
  ["other:ff", undefined],
  ...["", "abc", "zz"].map((hex) => [`session-state:${hex}`, undefined] as const),
] as const)("decodes only valid session-state context keys: %s", (key, expected) => {
  expect(decodeSessionStateNoticeContextKey(key)).toBe(expected);
});

it.each(["capture refusal", "pre-claim rejection", "released admission"] as const)(
  "recovers an unadopted notice after %s and soft restart",
  async (failure) => {
    const input = {
      watcherSessionKey: "agent:main:main",
      watcherStorePath: "/synthetic/store.sqlite",
      targetSessionKey: "agent:main:child",
      lastSeenSequence: 42,
    };
    if (failure === "capture refusal") {
      mocks.capture.mockRejectedValueOnce(new Error("Gateway is restarting"));
    } else {
      mocks.capture.mockResolvedValueOnce({ sessionId: "original", generation: "retired" });
      mocks.enqueue.mockImplementationOnce(() => {
        if (failure === "pre-claim rejection") {
          throw new Error("Captured lifecycle generation retired before claim");
        }
        return {
          id: "rejected-notice",
          accepted: Promise.resolve({ ok: false, error: "Gateway is restarting" }),
          cancel: () => false,
          settled: Promise.resolve({
            status: "cancelled",
            executionStarted: false,
            delivered: false,
          }),
        };
      });
    }
    mocks.capture.mockResolvedValueOnce({ sessionId: "original", generation: "replacement" });
    enqueueSessionStateNotice(input);
    await vi.advanceTimersByTimeAsync(20_000);
    const original = mocks.pending.find(
      (event) =>
        event.contextKey ===
        `session-state:${Buffer.from(input.targetSessionKey, "utf8").toString("hex")}`,
    );
    expect(original?.id).toEqual(expect.any(String));
    const priorHandoffs = failure === "capture refusal" ? 0 : 1;
    expect(mocks.enqueue).toHaveBeenCalledTimes(priorHandoffs);
    expect(mocks.acknowledge).not.toHaveBeenCalled();

    await drainGlobalSingletonLifecycleState("restart");
    enqueueSessionStateNotice(input);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.enqueue).toHaveBeenCalledTimes(priorHandoffs + 1);
    const handoff = mocks.enqueue.mock.calls.at(-1)![1];
    expect(handoff.expectedTarget?.generation).toBe("replacement");
    expect(handoff.occurrences?.map((event) => event.id)).toEqual([original?.id]);
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    await handoff.onAdopted?.();
    expect(mocks.acknowledge).toHaveBeenCalledOnce();
  },
);

it("rejects a late pre-restart capture without replacing the fresh recovery", async () => {
  const input = {
    watcherSessionKey: "agent:main:main",
    watcherStorePath: "/synthetic/store.sqlite",
    targetSessionKey: "agent:main:child",
    lastSeenSequence: 42,
  };
  const retiredCapture = createDeferred<SessionEventTarget>();
  mocks.capture
    .mockReturnValueOnce(retiredCapture.promise)
    .mockResolvedValueOnce({ sessionId: "original", generation: "replacement" });
  enqueueSessionStateNotice(input);
  await drainGlobalSingletonLifecycleState("restart");
  enqueueSessionStateNotice(input);
  retiredCapture.resolve({ sessionId: "original", generation: "retired" });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(mocks.enqueue).toHaveBeenCalledOnce();
  expect(mocks.enqueue.mock.calls[0]![1].expectedTarget?.generation).toBe("replacement");
  expect(mocks.capture).toHaveBeenCalledTimes(2);
  expect(mocks.acknowledge).not.toHaveBeenCalled();
});

it("recovers an unadopted notice under fresh authority after soft restart", async () => {
  const input = {
    watcherSessionKey: "agent:main:main",
    watcherStorePath: "/synthetic/store.sqlite",
    targetSessionKey: "agent:main:child",
    lastSeenSequence: 42,
  };
  mocks.pending.push({ id: "passive", text: "Unrelated passive notice", ts: 1 });
  mocks.capture
    .mockResolvedValueOnce({ sessionId: "original", generation: "retired" })
    .mockResolvedValueOnce({ sessionId: "original", generation: "replacement" });
  enqueueSessionStateNotice(input);
  await vi.advanceTimersByTimeAsync(1);
  const original = mocks.pending.find(
    (event) =>
      event.contextKey ===
      `session-state:${Buffer.from(input.targetSessionKey, "utf8").toString("hex")}`,
  );
  expect(original?.id).toEqual(expect.any(String));

  await drainGlobalSingletonLifecycleState("restart");
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.acknowledge).not.toHaveBeenCalled();
  // Startup sweep republishes the still-pending durable cursor, not a caller wake.
  enqueueSessionStateNotice(input);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);

  expect(mocks.enqueue).toHaveBeenCalledOnce();
  const handoff = mocks.enqueue.mock.calls[0]![1];
  expect(handoff.expectedTarget?.generation).toBe("replacement");
  expect(handoff.occurrences).toHaveLength(1);
  expect(handoff.occurrences?.[0]?.id).toBe(original?.id);
  expect(mocks.pending.filter((event) => event.id === "passive")).toHaveLength(1);
  expect(mocks.acknowledge).not.toHaveBeenCalled();
  await handoff.onAdopted?.();
  expect(mocks.acknowledge).toHaveBeenCalledOnce();
});

it("reserves one occurrence through capture, debounce, and handoff settlement", async () => {
  const input = {
    watcherSessionKey: "agent:main:main",
    targetSessionKey: "agent:main:child",
    lastSeenSequence: 42,
  };
  const capture = createDeferred<SessionEventTarget>();
  const settled = createDeferred<SessionEventOutcome>();
  mocks.capture.mockReturnValueOnce(capture.promise);
  mocks.enqueue.mockReturnValueOnce({
    id: "owned-notice",
    accepted: Promise.resolve({ ok: true }),
    cancel: () => false,
    settled: settled.promise,
  });
  try {
    enqueueSessionStateNotice(input);
    enqueueSessionStateNotice(input);
    expect(mocks.capture).toHaveBeenCalledOnce();
    capture.resolve({ sessionId: "original", generation: "current" });
    await vi.advanceTimersByTimeAsync(1);
    enqueueSessionStateNotice(input);
    await vi.advanceTimersByTimeAsync(19_999);
    enqueueSessionStateNotice(input);
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.pending).toHaveLength(1);
  } finally {
    capture.resolve({ sessionId: "original", generation: "current" });
    settled.resolve({ status: "completed", executionStarted: true, delivered: false });
    await vi.runAllTimersAsync();
  }
});

it("does not rearm a projection claimed by another turn", async () => {
  const input = {
    watcherSessionKey: "agent:main:main",
    targetSessionKey: "agent:main:child",
    lastSeenSequence: 42,
  };
  enqueueSessionStateNotice({ ...input, queueOnly: true });
  const event = mocks.pending[0]!;
  mocks.ownedIds.add(event.id!);
  enqueueSessionStateNotice(input);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.pending).toEqual([event]);
});

it("cancels a newer watcher buffer when an older queued batch starts during close", async () => {
  const firstSettled = createDeferred<SessionEventOutcome>();
  const secondSettled = createDeferred<SessionEventOutcome>();
  const secondEnqueued = createDeferred();
  mocks.enqueue
    .mockImplementationOnce(() => receipt("first-batch", firstSettled.promise))
    .mockImplementationOnce(() => {
      secondEnqueued.resolve();
      return receipt("second-batch", secondSettled.promise);
    });
  try {
    enqueue("agent:main:first");
    await vi.advanceTimersByTimeAsync(20_000);
    enqueue("agent:main:second");
    await vi.advanceTimersByTimeAsync(20_000);
    enqueue("agent:main:third");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    await mocks.enqueue.mock.calls[0]![1].onAdopted?.();
    await secondEnqueued.promise;
    firstSettled.resolve(done);
    secondSettled.resolve(done);
    await drainGlobalSingletonLifecycleState("restart");
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  } finally {
    firstSettled.resolve({ status: "cancelled", executionStarted: false, delivered: false });
    secondSettled.resolve({ status: "cancelled", executionStarted: false, delivered: false });
    await drainGlobalSingletonLifecycleState("restart");
  }
});

it("keeps different captured delivery routes in separate watcher batches", async () => {
  for (const to of ["first", "second"]) {
    mocks.capture.mockResolvedValueOnce({
      sessionId: "original",
      generation: "current",
      deliveryContext: { channel: "slack", to },
    });
  }
  for (const targetSessionKey of ["agent:main:first", "agent:main:second"]) {
    enqueue(targetSessionKey);
  }
  await vi.advanceTimersByTimeAsync(20_000);
  expect(
    mocks.enqueue.mock.calls.map(([, options]) => [
      options.expectedTarget?.deliveryContext?.to,
      options.occurrences?.length,
    ]),
  ).toEqual([
    ["first", 1],
    ["second", 1],
  ]);
});

it("keeps the first deadline and acknowledges coalesced store notices only upon adoption", async () => {
  const watcherStorePath = "/synthetic/store.sqlite";
  const watcherSessionKey = "agent:main:main";
  const targets = ["agent:main:slack:channel:C01234567", "agent:main:second"] as const;
  enqueue(targets[0], { watcherStorePath, lastSeenSequence: 42 });
  await vi.advanceTimersByTimeAsync(10_000);
  enqueue(targets[1], { watcherStorePath, lastSeenSequence: 2 });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.acknowledge).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  const options = mocks.enqueue.mock.calls[0]![1];
  expect(options).toMatchObject({
    source: "session",
    sessionKey: watcherSessionKey,
    expectedTarget: { sessionId: "original", generation: "current" },
    occurrences: targets.map(() => ({ sessionStorePath: watcherStorePath })),
  });
  expect(mocks.acknowledge).not.toHaveBeenCalled();
  await options.onAdopted?.();
  expect(mocks.acknowledge).toHaveBeenCalledWith(
    watcherSessionKey,
    targets.map((targetSessionKey) => ({ targetSessionKey, watcherStorePath })),
    expect.any(Function),
    expect.objectContaining({ assertCurrent: expect.any(Function) }),
  );
});

it.each([
  { watcherSessionKey: "agent:main:main", queueOnly: true },
  { watcherSessionKey: "agent:main:subagent:child", queueOnly: false },
])("keeps ambient notices passive for $watcherSessionKey", async (options) => {
  enqueue("agent:main:group:watched", { ...options, lastSeenSequence: 42 });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(mocks.pending).toHaveLength(1);
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.acknowledge).not.toHaveBeenCalled();
});

it("does not adopt a notice consumed during coalescing", async () => {
  enqueue("agent:main:group:watched", { lastSeenSequence: 42 });
  await vi.advanceTimersByTimeAsync(1);
  mocks.pending.length = 0;
  await vi.advanceTimersByTimeAsync(19_999);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.acknowledge).not.toHaveBeenCalled();
});
