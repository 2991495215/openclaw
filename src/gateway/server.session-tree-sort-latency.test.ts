import { availableParallelism, loadavg } from "node:os";
import { assert, expect, onTestFinished, test, vi } from "vitest";
import { WebSocket } from "ws";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import { GatewayBrowserClient, type GatewayEventFrame } from "../../ui/src/api/gateway.ts";
import type { GatewaySessionRow } from "../../ui/src/api/types.ts";
import { createSessionCapability } from "../../ui/src/lib/sessions/index.ts";
import { compareSessionRowsByUpdatedAt } from "../../ui/src/lib/sessions/navigation.ts";
import * as baselineReconciler from "../../ui/src/lib/sessions/reconcile.tree-sort-baseline.test-support.ts";
import { createGatewayHarness } from "../../ui/src/lib/sessions/session-capability.test-support.ts";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { captureGatewayKernel } from "./server.capture-kernel.test-support.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";
import { drainSessionEventPublications } from "./session-event-prepared-row.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { installGatewayTestHooks } from "./test-helpers.js";

test("preserves alias matching, filtered removals, references and untouched order", async () => {
  const candidate = await vi.importActual<typeof import("../../ui/src/lib/sessions/reconcile.ts")>(
    "../../ui/src/lib/sessions/reconcile.ts",
  );
  const row = (
    key: string,
    updatedAt: number,
    fields: Partial<GatewaySessionRow> = {},
  ): GatewaySessionRow => ({ key, sessionId: key, kind: "direct", updatedAt, ...fields });
  const rows = [
    row("main", 1, { sessionId: "alias" }),
    row("agent:main:main", 20, { sessionId: "alias" }),
    row("agent:main:other", 10),
  ];
  const initial = () => ({
    ts: 20,
    path: "synthetic",
    count: rows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: structuredClone(rows),
  });
  const payload = {
    agentId: "main",
    session: row("agent:main:other", 30),
    ancestorSessions: [
      { ...row("main", 22, { sessionId: "alias" }), ancestorRevision: "alias-revision" },
    ],
    ts: 30,
  };
  const left = baselineReconciler.reconcileSessionChanged(initial(), payload);
  const right = candidate.reconcileSessionChanged(initial(), payload);
  expect(right).toEqual(left);
  expect(right.result?.sessions.find((entry) => entry.key === "main")?.updatedAt).toBe(1);
  const reference = {
    ...payload,
    ancestorSessions: [],
    ancestorSessionRefs: [
      { key: "main", sessionId: "alias", revision: "alias-revision", snapshotAt: 31 },
    ],
    ts: 31,
  };
  expect(candidate.reconcileSessionChanged(right.result, reference)).toEqual(
    baselineReconciler.reconcileSessionChanged(left.result, reference),
  );
  for (const event of [
    {
      agentId: "main",
      sessionKey: "agent:main:other",
      sessionId: "agent:main:other",
      reason: "delete",
    },
    {
      agentId: "main",
      session: row("agent:main:other", 30, { archived: true }),
      ancestorSessions: [],
    },
    { agentId: "main", session: row("agent:main:other", 10), ancestorSessions: [] },
  ]) {
    const a = initial();
    const b = initial();
    const expected = baselineReconciler.reconcileSessionChanged(a, event);
    const actual = candidate.reconcileSessionChanged(b, event);
    expect(actual).toEqual(expected);
    if (expected.result?.sessions === a.sessions) {
      expect(actual.result?.sessions).toBe(b.sessions);
    }
  }
});

type Variant = "baseline" | "candidate";
const observation = vi.hoisted(() => ({ variant: "candidate" as Variant }));
vi.mock("../../ui/src/lib/sessions/reconcile.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui/src/lib/sessions/reconcile.ts")>();
  const baseline =
    await import("../../ui/src/lib/sessions/reconcile.tree-sort-baseline.test-support.ts");
  return {
    ...actual,
    reconcileSessionChanged: (...args: Parameters<typeof actual.reconcileSessionChanged>) =>
      (observation.variant === "baseline" ? baseline : actual).reconcileSessionChanged(...args),
  };
});

let harness: Awaited<ReturnType<typeof startGatewayServerHarness>>;
let kernel: Awaited<ReturnType<typeof captureGatewayKernel>>;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
    kernel = await captureGatewayKernel(async () => {
      harness = await startGatewayServerHarness();
    });
    await waitForGatewayStartup(harness.port);
  },
  cleanup: async () => harness?.close(),
});

type Sample = {
  pair: number;
  shape: string;
  variant: Variant;
  phase: "cold" | "warm";
  wallMs: number;
  cpuMs: number;
};

test("measures tree-event reduction through the real Gateway and session capability", async () => {
  vi.stubGlobal("WebSocket", WebSocket);
  vi.stubGlobal("navigator", { platform: "node", userAgent: "synthetic-tree-sort-investigation" });
  const loadStart = loadavg();
  const receivers = new Set<(event: GatewayEventFrame) => void>();
  const ready = Promise.withResolvers<void>();
  let pending: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let activeKey = "";
  let requests = 0;
  const client = new GatewayBrowserClient({
    url: `ws://127.0.0.1:${harness.port}`,
    clientName: "cli",
    mode: "cli",
    platform: "node",
    onHello: () => ready.resolve(),
    onClose: ({ code }) => {
      const error = new Error(`Synthetic tree client closed: ${code}`);
      ready.reject(error);
      pending?.reject(error);
    },
    onRequestTiming: () => {
      requests += 1;
    },
    onEvent: (event) => {
      try {
        for (const receiver of receivers) {
          receiver(event);
        }
        const payload = event.payload as { session?: { key?: string }; sessionKey?: string } | null;
        if (
          event.event === "sessions.changed" &&
          (payload?.session?.key ?? payload?.sessionKey) === activeKey
        ) {
          pending?.resolve();
        }
      } catch (error) {
        pending?.reject(error);
      }
    },
  });
  const cleanup: Array<() => void> = [];
  const stop = () => {
    const error = new Error("Synthetic tree fixture disposed");
    ready.reject(error);
    pending?.reject(error);
    pending = undefined;
    while (cleanup.length) {
      cleanup.pop()!();
    }
    receivers.clear();
    client.stop();
  };
  onTestFinished(stop);
  client.start();
  const samples: Sample[] = [];
  const counts: Array<{ shape: string; variant: Variant; sorts: number }> = [];
  const events: Array<{
    shape: string;
    pair: number;
    iteration: number;
    full: number;
    references: number;
  }> = [];
  let serial = 0;
  try {
    await ready.promise;
    // Non-main operator roots implicitly parent to main; materialize that root
    // so the projection can certify the complete ancestor chain.
    const chain = [
      "agent:main:main",
      ...Array.from({ length: 16 }, (_, index) => `agent:main:tree-sort-depth-${index + 1}`),
    ];
    const plain = chain[0]!;
    const keys = [
      ...chain,
      ...Array.from({ length: 83 }, (_, index) => `agent:main:tree-sort-filler-${index}`),
    ];
    for (const [index, key] of keys.entries()) {
      await client.request("sessions.create", {
        key,
        agentId: "main",
        visibility: "shared",
        ...(index > 0 && index < chain.length
          ? { parentSessionKey: chain[index - 1], spawnDepth: index }
          : {}),
      });
    }
    const projection = getSessionRowProjection(kernel.gatewayRequestContext);
    assert(projection, "admitted projection");
    await flushPendingSessionsChangedEvents(kernel.gatewayRequestContext);
    await drainSessionEventPublications(projection);
    await client.request("health", {});
    await client.request("sessions.subscribe", {});
    const patch = async (key: string) => {
      activeKey = key;
      pending = Promise.withResolvers<void>();
      void pending.promise.catch(() => {});
      await client.request("sessions.patch", { key, label: `Synthetic update ${serial++}` });
      await flushPendingSessionsChangedEvents(kernel.gatewayRequestContext);
      await drainSessionEventPublications(projection);
      await pending.promise;
      pending = undefined;
      activeKey = "";
      await client.request("health", {});
    };
    for (const shape of [
      { name: "tree", key: chain.at(-1)!, ancestors: 16 },
      { name: "plain", key: plain, ancestors: 0 },
    ]) {
      for (let pair = 0; pair < 6; pair += 1) {
        const subjects = [];
        for (const variant of (pair % 2
          ? ["candidate", "baseline"]
          : ["baseline", "candidate"]) as Variant[]) {
          const adapter = createGatewayHarness(client);
          const sessions = createSessionCapability(adapter.gateway, {
            state: { selectedId: "main" },
            subscribe: () => () => {},
          });
          cleanup.push(() => sessions.dispose());
          await sessions.refresh({
            agentId: "main",
            rowMode: "sidebar",
            archivedFilter: "all",
            limit: 100,
          });
          expect(sessions.state.result?.sessions).toHaveLength(100);
          const rows = sessions.state.result!.sessions;
          expect(rows.find((row) => row.key === plain)?.parentSessionKey).toBeUndefined();
          for (let index = 1; index < chain.length; index += 1) {
            expect(rows.find((row) => row.key === chain[index])?.parentSessionKey).toBe(
              chain[index - 1],
            );
          }
          let delivered = 0;
          const observer = sessions.observeRow({ key: shape.key, agentId: "main" }, () => {}, {
            onEvent: () => {
              delivered += 1;
            },
          });
          cleanup.push(() => observer.dispose());
          subjects.push({ variant, adapter, sessions, readDelivered: () => delivered });
        }
        await client.request("health", {});
        let iteration = 0;
        let countMode = false;
        let sortCounter = 0;
        const emit = (subject: (typeof subjects)[number], event: GatewayEventFrame) => {
          observation.variant = subject.variant;
          subject.adapter.emitEvent(event);
        };
        const receive = (event: GatewayEventFrame) => {
          const payload = event.payload as {
            session?: { key?: string };
            sessionKey?: string;
            ancestorSessions?: unknown[];
            ancestorSessionRefs?: unknown[];
          } | null;
          if (
            event.event !== "sessions.changed" ||
            (payload?.session?.key ?? payload?.sessionKey) !== shape.key
          ) {
            for (const subject of subjects) {
              emit(subject, event);
            }
            return;
          }
          expect(
            (payload?.ancestorSessions?.length ?? 0) + (payload?.ancestorSessionRefs?.length ?? 0),
          ).toBe(shape.ancestors);
          events.push({
            shape: shape.name,
            pair,
            iteration,
            full: payload?.ancestorSessions?.length ?? 0,
            references: payload?.ancestorSessionRefs?.length ?? 0,
          });
          for (const subject of subjects) {
            if (countMode) {
              sortCounter = 0;
              emit(subject, event);
              counts.push({ shape: shape.name, variant: subject.variant, sorts: sortCounter });
            } else {
              const cpu = process.cpuUsage();
              const start = performance.now();
              emit(subject, event);
              const wallMs = performance.now() - start;
              const used = process.cpuUsage(cpu);
              samples.push({
                pair,
                shape: shape.name,
                variant: subject.variant,
                phase: iteration === 0 ? "cold" : "warm",
                wallMs,
                cpuMs: (used.user + used.system) / 1_000,
              });
            }
          }
          expect(subjects[0]!.sessions.state.result).toEqual(subjects[1]!.sessions.state.result);
        };
        receivers.add(receive);
        const before = requests;
        for (; iteration < 9; iteration += 1) {
          await patch(shape.key);
        }
        expect(requests - before).toBe(18);
        for (const subject of subjects) {
          expect(subject.readDelivered()).toBe(9);
        }
        if (pair === 0) {
          countMode = true;
          const original = Array.prototype.sort;
          using spy = vi.spyOn(Array.prototype, "sort").mockImplementation(function (
            this: unknown[],
            compare,
          ) {
            if (compare === compareSessionRowsByUpdatedAt) {
              sortCounter += 1;
            }
            return original.call(this, compare);
          });
          void spy;
          await patch(shape.key);
        }
        receivers.delete(receive);
        while (cleanup.length) {
          cleanup.pop()!();
        }
      }
    }
    expect(counts).toEqual([
      { shape: "tree", variant: "baseline", sorts: 17 },
      { shape: "tree", variant: "candidate", sorts: 1 },
      { shape: "plain", variant: "baseline", sorts: 1 },
      { shape: "plain", variant: "candidate", sorts: 1 },
    ]);
    console.log(
      "SESSION_TREE_SORT_RESULT " +
        JSON.stringify({
          base: "e29f83774f4ac8f52a379d8e9f55c2fcbcb8e2be",
          runtime: {
            node: process.version,
            bun: (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun,
          },
          cpus: availableParallelism(),
          loadStart,
          loadEnd: loadavg(),
          counts,
          events,
          samples,
        }),
    );
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});
