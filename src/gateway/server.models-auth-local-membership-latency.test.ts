import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "../agents/auth-profiles/types.js";
import { prepareModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelAuthStatusResult } from "./server-methods/models-auth-status.types.js";
import {
  createModelsTestState,
  modelsTestConfig,
  startModelsGateway,
} from "./server-methods/models-integration.test-support.js";
import { readPreparedGatewayModelCatalogOwnerSnapshot } from "./server-model-catalog.js";

type Variant = "baseline" | "candidate";
type Timing = { wallMs: number; cpuMs: number; rpcMs: number };
const observation = vi.hoisted(() => ({
  variant: "baseline" as Variant,
  measure: false,
  timing: undefined as Omit<Timing, "rpcMs"> | undefined,
  localIds: undefined as string[] | undefined,
}));

// Compare the two actual handlers behind the normal registry, admission and socket.
vi.mock("./server-methods/models-auth-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-methods/models-auth-status.js")>();
  const baseline =
    await import("./server-methods/models-auth-status.local-membership-baseline.test-support.js");
  return {
    ...actual,
    modelsAuthStatusHandlers: {
      ...actual.modelsAuthStatusHandlers,
      "models.authStatus": async (
        options: Parameters<
          NonNullable<(typeof actual.modelsAuthStatusHandlers)["models.authStatus"]>
        >[0],
      ) => {
        const handler = (observation.variant === "baseline" ? baseline : actual)
          .modelsAuthStatusHandlers["models.authStatus"]!;
        const measured = observation.measure;
        const cpu = measured ? process.cpuUsage() : undefined;
        const start = measured ? performance.now() : 0;
        return handler({
          ...options,
          respond: (...args) => {
            if (measured && cpu) {
              const wallMs = performance.now() - start;
              const used = process.cpuUsage(cpu);
              observation.timing = { wallMs, cpuMs: (used.user + used.system) / 1_000 };
            }
            options.respond(...args);
          },
        });
      },
    },
  };
});

// Observe the real published store; do not substitute profile facts or owner currency.
vi.mock("./server-model-catalog-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-model-catalog-auth.js")>();
  return {
    ...actual,
    readPreparedCatalog: async (...args: Parameters<typeof actual.readPreparedCatalog>) => {
      const snapshot = await actual.readPreparedCatalog(...args);
      const store: RuntimeAuthProfileStore | undefined = snapshot?.authStore;
      observation.localIds = store?.runtimeLocalProfileIds;
      return snapshot;
    },
  };
});

afterEach(() => {
  observation.measure = false;
  observation.timing = undefined;
  observation.localIds = undefined;
  vi.restoreAllMocks();
});

const shapes = [
  { name: "many", providers: 20, profilesPerProvider: 32 },
  { name: "single", providers: 1, profilesPerProvider: 32 },
  { name: "empty", providers: 0, profilesPerProvider: 0 },
] as const;
type Shape = (typeof shapes)[number];
const variants: Variant[] = ["baseline", "candidate"];
const rounds = 6;
const warmSamples = 8;

function profileStore(shape: Shape): AuthProfileStore {
  const profiles: AuthProfileStore["profiles"] = {};
  for (let provider = 0; provider < shape.providers; provider += 1) {
    const id = `synthetic-provider-${provider}`;
    for (let profile = 0; profile < shape.profilesPerProvider; profile += 1) {
      profiles[`${id}:profile-${profile}`] = {
        type: "api_key",
        provider: id,
        key: "synthetic-fixture-key",
      };
    }
  }
  return { version: 1, profiles };
}

function assertResponse(result: ModelAuthStatusResult, shape: Shape) {
  expect(result.unavailable).toBeUndefined();
  expect(result.providers).toHaveLength(shape.providers);
  for (let provider = 0; provider < shape.providers; provider += 1) {
    const id = `synthetic-provider-${provider}`;
    const status = result.providers.find((entry) => entry.provider === id);
    expect(status?.status).toBe("static");
    expect(status?.profiles).toHaveLength(shape.profilesPerProvider);
    expect(status?.profiles).toEqual(
      expect.arrayContaining(
        Array.from({ length: shape.profilesPerProvider }, (_, profile) =>
          expect.objectContaining({
            profileId: `${id}:profile-${profile}`,
            type: "api_key",
            status: "static",
            source: "saved",
            logoutSupported: true,
          }),
        ),
      ),
    );
  }
}

function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}

function measuredTiming(): Omit<Timing, "rpcMs"> {
  const timing = observation.timing;
  if (!timing) {
    throw new Error("The registered handler did not report a timing");
  }
  return timing;
}

it("measures request-local profile membership through the registered Gateway method", async () => {
  const loadStart = os.loadavg();
  const setupStart = performance.now();
  await using state = await createModelsTestState("model-auth-local-membership", {
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
  });
  const entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {
    main: { workspace: state.workspaceDir },
  };
  const cases: Array<{ shape: Shape; round: number; variant: Variant; agentId: string }> = [];
  for (const shape of shapes) {
    for (let round = 0; round < rounds; round += 1) {
      for (const variant of round % 2 ? variants.toReversed() : variants) {
        const agentId = `${shape.name}-${round}-${variant}`;
        entries[agentId] = { workspace: state.workspaceDir };
        await state.writeAuthProfiles(profileStore(shape), agentId);
        cases.push({ shape, round, variant, agentId });
      }
    }
  }
  const token = "synthetic-local-membership-token";
  const cfg = modelsTestConfig(state, token, { agents: { ownership: "explicit", entries } });
  await state.writeConfig(cfg);
  await using gateway = await startModelsGateway(state, cfg, token);
  await gateway.server.startupSettled;
  for (const fixture of cases) {
    // Passive reads join the configured owner's pending build; they cannot activate one.
    await prepareModelRuntimeSnapshot(
      {
        config: getRuntimeConfig(),
        agentId: fixture.agentId,
        agentDir: state.agentDir(fixture.agentId),
      },
      { readPublished: true },
    );
    const owner = await readPreparedGatewayModelCatalogOwnerSnapshot({ agentId: fixture.agentId });
    expect(owner).toBeDefined();
    expect(owner!.isCurrent()).toBe(true);
    const store: RuntimeAuthProfileStore = owner!.authStore;
    expect(Object.keys(owner!.authStore.profiles)).toHaveLength(
      fixture.shape.providers * fixture.shape.profilesPerProvider,
    );
    expect(store.runtimeLocalProfileIds).toHaveLength(
      fixture.shape.providers * fixture.shape.profilesPerProvider,
    );
  }
  const setupMs = performance.now() - setupStart;
  const samples: Array<{
    shape: string;
    round: number;
    variant: Variant;
    phase: "cold" | "warm";
    timings: Timing[];
  }> = [];
  const request = async (fixture: (typeof cases)[number], measure: boolean) => {
    observation.variant = fixture.variant;
    observation.measure = measure;
    observation.timing = undefined;
    const start = performance.now();
    const result = await gateway.client.request<ModelAuthStatusResult>("models.authStatus", {
      agentId: fixture.agentId,
    });
    const rpcMs = performance.now() - start;
    observation.measure = false;
    assertResponse(result, fixture.shape);
    if (!measure) {
      return undefined;
    }
    return { ...measuredTiming(), rpcMs };
  };
  // Every cold sample has a distinct prepared agent and untouched status-facts cache.
  // Warm samples follow that same agent, retaining the single usage-runtime snapshot.
  for (const fixture of cases) {
    const { shape, round, variant } = fixture;
    samples.push({
      shape: shape.name,
      round,
      variant,
      phase: "cold",
      timings: [(await request(fixture, true))!],
    });
    const timings: Timing[] = [];
    for (let sample = 0; sample < warmSamples; sample += 1) {
      timings.push((await request(fixture, true))!);
    }
    samples.push({ shape: shape.name, round, variant, phase: "warm", timings });
  }
  const counts: Array<{ shape: string; variant: Variant; sets: number; entries: number }> = [];
  const OriginalSet = globalThis.Set;
  // Constructor observation is a separate, untimed request, restored before every next case.
  for (const shape of shapes) {
    for (const variant of variants) {
      const fixture = cases.find((item) => item.shape === shape && item.variant === variant)!;
      let sets = 0;
      let inserted = 0;
      globalThis.Set = new Proxy(OriginalSet, {
        construct(target, args, newTarget) {
          if (observation.localIds && args[0] === observation.localIds) {
            sets += 1;
            inserted += observation.localIds.length;
          }
          return Reflect.construct(target, args, newTarget);
        },
      });
      try {
        await request(fixture, false);
      } finally {
        globalThis.Set = OriginalSet;
      }
      expect(sets).toBe(variant === "baseline" ? shape.providers : Math.min(shape.providers, 1));
      expect(inserted).toBe(sets * shape.providers * shape.profilesPerProvider);
      counts.push({ shape: shape.name, variant, sets, entries: inserted });
    }
  }
  const summary = shapes.flatMap((shape) =>
    variants.flatMap((variant) =>
      (["cold", "warm"] as const).map((phase) => {
        const values = samples
          .filter(
            (sample) =>
              sample.shape === shape.name && sample.variant === variant && sample.phase === phase,
          )
          .flatMap((sample) => sample.timings);
        return {
          shape: shape.name,
          variant,
          phase,
          wallMs: distribution(values.map((value) => value.wallMs)),
          cpuMs: distribution(values.map((value) => value.cpuMs)),
          rpcMs: distribution(values.map((value) => value.rpcMs)),
        };
      }),
    ),
  );
  console.log(
    "MODEL_AUTH_LOCAL_SET_RESULT",
    JSON.stringify({
      base: "e29f83774f4ac8f52a379d8e9f55c2fcbcb8e2be",
      rounds,
      warmSamples,
      cold: "first status request per prepared agent; warm process and connection",
      boundary:
        "registered handler entry through response preparation; excludes encoding and transport",
      acceptance:
        "many-provider warm wall median improves >=10%; all shapes/cold/warm wall+CPU median/p95 regressions <20%",
      setupMs,
      runtime: { node: process.version, bun: process.versions.bun },
      platform: process.platform,
      cpus: os.cpus().length,
      loadStart,
      loadEnd: os.loadavg(),
      counts,
      samples,
      summary,
    }),
  );
});
