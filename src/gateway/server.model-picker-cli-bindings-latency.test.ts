import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../packages/gateway-protocol/src/schema/model-catalog.js";
import { prepareModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createCatalogModel,
  writeCatalogPlugin,
} from "./server-methods/models-catalog-fixture.test-support.js";
import {
  createModelsTestState,
  modelsTestConfig,
  startModelsGateway,
} from "./server-methods/models-integration.test-support.js";
import { readPreparedGatewayModelCatalogOwnerSnapshot } from "./server-model-catalog.js";

type Variant = "baseline" | "candidate";
type Mode = "idle" | "measure" | "count";
type Timing = { rpcMs: number; cpuMs: number; helperMs: number; helperCalls: number };
const observation = vi.hoisted(() => ({
  variant: "baseline" as Variant,
  mode: "idle" as Mode,
  agentId: "",
  helperMs: 0,
  helperCalls: 0,
  countDepth: 0,
  registryReads: 0,
}));

// Keep the real registry/handler/transport; select only the helper under investigation.
vi.mock("./server-methods/models-list-runtime-choices.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./server-methods/models-list-runtime-choices.js")>();
  const baseline =
    await import("./server-methods/models-list-runtime-choices.baseline.test-support.js");
  return {
    ...actual,
    prepareModelPickerRuntimeChoices: (
      params: Parameters<typeof actual.prepareModelPickerRuntimeChoices>[0],
    ) => {
      const selected = params.agentId === observation.agentId && observation.mode !== "idle";
      const implementation = selected && observation.variant === "baseline" ? baseline : actual;
      if (!selected) {
        return implementation.prepareModelPickerRuntimeChoices(params);
      }
      observation.helperCalls += 1;
      const start = observation.mode === "measure" ? performance.now() : undefined;
      if (observation.mode === "count") {
        observation.countDepth += 1;
      }
      try {
        return implementation.prepareModelPickerRuntimeChoices(params);
      } finally {
        if (start !== undefined) {
          observation.helperMs += performance.now() - start;
        }
        if (observation.mode === "count") {
          observation.countDepth -= 1;
        }
      }
    },
  };
});

// Count actual registry materializations, including compatibility calls, only in untimed requests.
vi.mock("../plugins/cli-backends.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/cli-backends.runtime.js")>();
  return {
    ...actual,
    resolveRuntimeCliBackends: (...args: Parameters<typeof actual.resolveRuntimeCliBackends>) => {
      if (observation.countDepth > 0) {
        observation.registryReads += 1;
      }
      return actual.resolveRuntimeCliBackends(...args);
    },
  };
});

afterEach(() => {
  observation.mode = "idle";
  observation.agentId = "";
  vi.restoreAllMocks();
});

const provider = "picker-fixture";
const runtime = "fixture-cli";
const shapes = [
  { name: "many", models: 32, alternatives: true },
  { name: "single", models: 1, alternatives: true },
  { name: "no-alternative", models: 32, alternatives: false },
] as const;
type Shape = (typeof shapes)[number];
const variants: Variant[] = ["baseline", "candidate"];
const rounds = 6;
const warmSamples = 8;

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

function assertResponse(result: ModelsListResult, shape: Shape) {
  expect(result.models).toHaveLength(shape.models);
  for (let index = 0; index < shape.models; index += 1) {
    const model = result.models.find((entry) => entry.id === `model-${index}`);
    expect(model).toMatchObject({ provider, id: `model-${index}` });
    expect(model?.runtimeChoices?.map((choice) => choice.agentRuntime.id) ?? []).toEqual(
      shape.alternatives ? [runtime] : [],
    );
  }
}

it("measures prepared CLI binding reuse through registered models.list", async () => {
  const loadStart = os.loadavg();
  const setupStart = performance.now();
  await using state = await createModelsTestState("model-picker-cli-bindings", {
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
  });
  const backendIds = [runtime, ...Array.from({ length: 7 }, (_, index) => `other-cli-${index}`)];
  const plugin = await writeCatalogPlugin(
    state,
    provider,
    `module.exports = {
      id: "${provider}", register(api) {
        const ids = ${JSON.stringify(backendIds)};
        for (const [index, id] of ids.entries()) {
          api.registerCliBackend({
            id, modelProvider: index === 0 ? "${provider}" : "other-provider-" + index,
            config: { command: "synthetic-never-executed-cli" },
          });
        }
      }
    };`,
    { cliBackends: backendIds },
  );
  const entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {
    main: { workspace: state.workspaceDir },
  };
  const cases: Array<{ shape: Shape; round: number; variant: Variant; agentId: string }> = [];
  // The final pair for each shape supplies separate untimed work counts.
  for (const shape of shapes) {
    for (let round = 0; round <= rounds; round += 1) {
      for (const variant of round % 2 ? variants.toReversed() : variants) {
        const agentId = `${shape.name}-${round}-${variant}`;
        const refs = Array.from(
          { length: shape.models },
          (_, index) => `${provider}/model-${index}`,
        );
        entries[agentId] = {
          workspace: state.workspaceDir,
          model: refs[0],
          modelPolicy: { allow: refs },
          models: Object.fromEntries(
            refs.map((ref) => [
              ref,
              {
                agentRuntime: { id: "openclaw" },
                ...(shape.alternatives ? { pickerRuntimes: [runtime] } : {}),
              },
            ]),
          ),
        };
        cases.push({ shape, round, variant, agentId });
      }
    }
  }
  const token = "synthetic-picker-bindings-token";
  const cfg = modelsTestConfig(state, token, {
    agents: { ownership: "explicit", entries },
    plugins: {
      allow: [provider],
      load: { paths: [plugin] },
      slots: { memory: "none" },
      entries: { [provider]: { enabled: true } },
    },
    models: {
      providers: {
        [provider]: {
          api: "openai-completions",
          apiKey: "synthetic-picker-fixture-key",
          baseUrl: "https://models.example.test/v1",
          models: Array.from({ length: 32 }, (_, index) => createCatalogModel(`model-${index}`)),
        },
      },
    },
  });
  await state.writeConfig(cfg);
  await using gateway = await startModelsGateway(state, cfg, token);
  await gateway.server.startupSettled;
  for (const fixture of cases) {
    await prepareModelRuntimeSnapshot(
      {
        config: getRuntimeConfig(),
        agentId: fixture.agentId,
        agentDir: state.agentDir(fixture.agentId),
      },
      { readPublished: true },
    );
    const owner = await readPreparedGatewayModelCatalogOwnerSnapshot({ agentId: fixture.agentId });
    expect(owner?.isCurrent()).toBe(true);
    expect(owner?.pluginRegistry?.cliBackends).toHaveLength(backendIds.length);
    expect(
      owner?.pluginRegistry?.agentHarnesses.some(({ harness }) => harness.id === runtime),
    ).toBe(false);
  }
  const setupMs = performance.now() - setupStart;
  const samples: Array<{
    shape: string;
    round: number;
    variant: Variant;
    phase: "cold" | "warm";
    timings: Timing[];
  }> = [];
  const counts: Array<{ shape: string; variant: Variant; calls: number; registryReads: number }> =
    [];
  const pairedResponses = new Map<string, ModelsListResult>();
  const request = async (fixture: (typeof cases)[number], mode: Exclude<Mode, "idle">) => {
    observation.variant = fixture.variant;
    observation.agentId = fixture.agentId;
    observation.mode = mode;
    observation.helperMs = 0;
    observation.helperCalls = 0;
    observation.registryReads = 0;
    const cpu = mode === "measure" ? process.cpuUsage() : undefined;
    const start = performance.now();
    let result: ModelsListResult;
    try {
      result = await gateway.client.request<ModelsListResult>("models.list", {
        agentId: fixture.agentId,
        view: "configured",
        includeDetails: true,
      });
    } finally {
      observation.mode = "idle";
    }
    const rpcMs = performance.now() - start;
    const used = cpu && process.cpuUsage(cpu);
    const timing: Timing = {
      rpcMs,
      cpuMs: used ? (used.user + used.system) / 1_000 : 0,
      helperMs: observation.helperMs,
      helperCalls: observation.helperCalls,
    };
    assertResponse(result, fixture.shape);
    const key = `${fixture.shape.name}:${fixture.round}`;
    const previous = pairedResponses.get(key);
    if (previous) {
      expect(result).toEqual(previous);
    } else {
      pairedResponses.set(key, result);
    }
    return timing;
  };
  for (const fixture of cases) {
    const cold = await request(fixture, fixture.round === rounds ? "count" : "measure");
    expect(cold.helperCalls).toBe(fixture.shape.alternatives ? fixture.shape.models : 0);
    if (fixture.round === rounds) {
      counts.push({
        shape: fixture.shape.name,
        variant: fixture.variant,
        calls: cold.helperCalls,
        registryReads: observation.registryReads,
      });
      continue;
    }
    samples.push({
      shape: fixture.shape.name,
      round: fixture.round,
      variant: fixture.variant,
      phase: "cold",
      timings: [cold],
    });
    const timings: Timing[] = [];
    for (let sample = 0; sample < warmSamples; sample += 1) {
      const warm = await request(fixture, "measure");
      expect(warm.helperCalls).toBe(0);
      timings.push(warm);
    }
    samples.push({
      shape: fixture.shape.name,
      round: fixture.round,
      variant: fixture.variant,
      phase: "warm",
      timings,
    });
  }
  for (const shape of shapes) {
    const baseline = counts.find(
      (entry) => entry.shape === shape.name && entry.variant === "baseline",
    )!;
    const candidate = counts.find(
      (entry) => entry.shape === shape.name && entry.variant === "candidate",
    )!;
    expect(baseline.registryReads - candidate.registryReads).toBe(
      shape.alternatives ? shape.models : 0,
    );
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
          rpcMs: distribution(values.map((sample) => sample.rpcMs)),
          cpuMs: distribution(values.map((sample) => sample.cpuMs)),
          helperMs: distribution(values.map((sample) => sample.helperMs)),
        };
      }),
    ),
  );
  process.stdout.write(
    `MODEL_PICKER_CLI_BINDINGS_RESULT ${JSON.stringify({
      base: "e29f83774f4ac8f52a379d8e9f55c2fcbcb8e2be",
      setupMs,
      runtime: {
        node: process.version,
        bun: (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun,
      },
      platform: process.platform,
      cpus: os.availableParallelism(),
      loadStart,
      loadEnd: os.loadavg(),
      counts,
      summary,
      samples,
    })}\n`,
  );
});
