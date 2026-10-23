import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { afterAll, expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as preparedCatalog from "../../agents/prepared-model-catalog.js";
import * as preparedRuntime from "../../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as catalogGateway from "../server-model-catalog.js";
import * as baselineCatalog from "../server-model-catalog.latency-baseline.test-support.js";
import * as metadataRuntime from "./chat-metadata-runtime.js";
import * as baselineMetadata from "./chat-metadata-runtime.latency-baseline.test-support.js";
import {
  catalogModelDefaults,
  catalogModelIds,
  createCatalogState,
  writeCatalogPlugin,
} from "./models-catalog-fixture.test-support.js";
import { serveModelsEndpoint, startModelsGateway } from "./models-integration.test-support.js";

// Temporary source comparison: the baseline siblings come from dbf16e0, before the repair.
// Only the baseline runtime's relative facts import changes to preserve that owner pair.
const baselineSources = [
  [
    "./chat-metadata-runtime.latency-baseline.test-support.ts",
    "9e61ec10307715c3002aa1888944a97f5bc925409771695d7f6962702e104123",
  ],
  [
    "./chat-metadata-facts.latency-baseline.test-support.ts",
    "bed518a64c26482a48dbe4e7538f6fa705dea20a3bf4ce86675701c31c025f8c",
  ],
  [
    "../server-model-catalog.latency-baseline.test-support.ts",
    "b1e3579bd0431212e80b27cf19c2a8acd99ac1ed89418d9991aeb59919c4567d",
  ],
] as const;
for (const [file, digest] of baselineSources) {
  expect(
    createHash("sha256")
      .update(readFileSync(new URL(file, import.meta.url)))
      .digest("hex"),
  ).toBe(digest);
}
const completedSamples: Array<{
  variant: "baseline" | "candidate";
  sample: number;
  requestDurationsMs: Record<string, number>;
  startupMs: number;
}> = [];
const summarize = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    count: values.length,
    median: sorted[Math.ceil(values.length / 2) - 1],
    p95: sorted[Math.ceil(values.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
};
afterAll(() => {
  console.log(
    JSON.stringify({
      diagnostic: "models-list-scoped-replacement-summary",
      workloadsComplete: completedSamples.length === 10,
      baselineSources,
      sampleOrder: completedSamples.map(({ variant, sample }) => `${variant}/${sample}`),
      variants: Object.fromEntries(
        (["baseline", "candidate"] as const).map((variant) => {
          const samples = completedSamples.filter((sample) => sample.variant === variant);
          return [
            variant,
            {
              freshGatewayInLoadedProcessMs: summarize(samples.map((sample) => sample.startupMs)),
              requests: Object.fromEntries(
                [
                  "a-warm",
                  "a-retained",
                  "a-unseen",
                  "a-retained-checkpoint",
                  "a-after-replacement",
                ].map((name) => [
                  name,
                  summarize(samples.map((sample) => sample.requestDurationsMs[name]!)),
                ]),
              ),
            },
          ];
        }),
      ),
    }),
  );
});
const comparisonCases = Array.from({ length: 5 }, (_, sample) =>
  (["baseline", "candidate"] as const).map((variant) => ({ sample, variant })),
).flat();

it.for(comparisonCases)(
  "records models.list ordering $variant/$sample",
  async ({ sample, variant }, { signal }) => {
    await using state = await createCatalogState("scoped-model-replacement-latency");
    const provider = "scoped-latency-fixture";
    const initialLoad = loadavg();
    const initialCpu = process.cpuUsage();
    const initialRss = process.memoryUsage().rss;
    const startedAt = performance.now();
    const events: Array<{ name: string; elapsedMs: number }> = [];
    const record = (name: string) => {
      events.push({ name, elapsedMs: Number((performance.now() - startedAt).toFixed(3)) });
    };
    let holdPreparation = false;
    const preparationEntered = createDeferred();
    const heldResponses = new Set<ServerResponse>();
    const releasePreparation = () => {
      holdPreparation = false;
      for (const response of heldResponses) {
        response.writeHead(200).end();
      }
      heldResponses.clear();
    };
    const endpoint = createServer((request, response) => {
      if (request.url !== "/prepare") {
        response.writeHead(404).end();
        return;
      }
      if (holdPreparation) {
        heldResponses.add(response);
        record("b-preparation-held");
        preparationEntered.resolve();
        return;
      }
      response.writeHead(200).end();
    });
    await using listening = await serveModelsEndpoint(endpoint);
    const { baseUrl } = listening;
    const pluginPath = await writeCatalogPlugin(
      state,
      provider,
      `module.exports = {
      id: ${JSON.stringify(provider)},
      register(api) {
        api.registerProvider({
          id: ${JSON.stringify(provider)}, label: "Scoped latency fixture", auth: [],
          staticCatalog: {
            order: "simple",
            async run() {
              const response = await fetch(${JSON.stringify(`${baseUrl}/prepare`)});
              if (!response.ok) throw new Error("Synthetic preparation failed");
              return { provider: {
                baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
                models: [{ id: "fixture-model", name: "Fixture model", ...${JSON.stringify(catalogModelDefaults())} }],
              } };
            },
          },
        });
      },
    };`,
    );
    const token = "scoped-latency-synthetic-token";
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          skipBootstrap: true,
          model: { primary: `${provider}/fixture-model` },
          modelPolicy: { allow: [`${provider}/*`] },
        },
        entries: {
          main: { workspace: state.workspaceDir },
          sibling: { workspace: state.statePath("sibling-workspace") },
        },
      },
      models: {
        providers: {
          [provider]: {
            baseUrl,
            api: "openai-completions",
            apiKey: "synthetic-scoped-latency-key",
            models: [],
            request: { allowPrivateNetwork: true },
          },
        },
      },
      tools: { profile: "minimal" },
      plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    let gateway: Awaited<ReturnType<typeof startModelsGateway>> | undefined;
    const requests: Promise<ModelsListResult>[] = [];
    const settled = new Set<string>();
    const requestDurationsMs: Record<string, number> = {};
    const request = (name: string, agentId: string, view: "configured" | "provider-config") => {
      if (!gateway) {
        throw new Error("Synthetic Gateway has not started");
      }
      const requestStarted = performance.now();
      record(`${name}-sent`);
      const work = gateway.client.request<ModelsListResult>("models.list", { agentId, view }).then(
        (result) => {
          settled.add(name);
          requestDurationsMs[name] = Number((performance.now() - requestStarted).toFixed(3));
          record(`${name}-response`);
          return result;
        },
        (error: unknown) => {
          settled.add(name);
          record(`${name}-error`);
          throw error;
        },
      );
      requests.push(work);
      // Keep failures handled until the assertion or final drain observes them.
      void work.catch(() => {});
      return work;
    };
    let replacement: Promise<void> | undefined;
    let checkpoint: { scope: string; reached: ReturnType<typeof createDeferred<void>> } | undefined;
    const readScope = new AsyncLocalStorage<string>();
    const originalFactory =
      variant === "baseline"
        ? baselineMetadata.createGatewayChatMetadataRuntime
        : metadataRuntime.createGatewayChatMetadataRuntime;
    const originalCatalog =
      variant === "baseline"
        ? baselineCatalog.readPreparedGatewayModelCatalogOwnerSnapshot
        : catalogGateway.readPreparedGatewayModelCatalogOwnerSnapshot;
    let factoryCalls = 0;
    let catalogCalls = 0;
    const catalogSpy = vi
      .spyOn(catalogGateway, "readPreparedGatewayModelCatalogOwnerSnapshot")
      .mockImplementation((...args) => {
        catalogCalls++;
        return originalCatalog(...args);
      });
    const factorySpy = vi
      .spyOn(metadataRuntime, "createGatewayChatMetadataRuntime")
      .mockImplementation((params) => {
        factoryCalls++;
        const runtime = originalFactory(params);
        const read = runtime.readModelsList;
        return {
          ...runtime,
          readModelsList: (input) =>
            readScope.run(`${input.agentId}:${input.params.view}`, () => read(input)),
        };
      });
    const originalPending = preparedCatalog.getPendingPreparedModelRuntimeReplacement;
    const pendingSpy = vi
      .spyOn(preparedCatalog, "getPendingPreparedModelRuntimeReplacement")
      .mockImplementation(() => {
        const pending = originalPending();
        // Attribute the call without replacing the owner's actual pending Promise.
        if (pending && checkpoint && readScope.getStore() === checkpoint.scope) {
          record("a-unseen-pending-replacement-observed");
          checkpoint.reached.resolve();
          checkpoint = undefined;
        }
        return pending;
      });
    const bEntered = createDeferred();
    let observeB = false;
    const originalReady = preparedRuntime.ensureGatewayPreparedModelRuntimeReady;
    const readySpy = vi
      .spyOn(preparedRuntime, "ensureGatewayPreparedModelRuntimeReady")
      .mockImplementation((params) => {
        const work = originalReady(params);
        if (observeB && params.agentId === "sibling") {
          observeB = false;
          record("b-readiness-entered");
          bEntered.resolve();
          void work.then(
            () => record("b-readiness-settled"),
            () => record("b-readiness-rejected"),
          );
        }
        return work;
      });
    let completed = false;
    let startupMs = 0;
    try {
      const startupStarted = performance.now();
      gateway = await startModelsGateway(state, cfg, token);
      await withinTest(gateway.server.startupSettled, signal);
      startupMs = performance.now() - startupStarted;
      const initial = await withinTest(request("a-warm", "main", "configured"), signal);
      expect(catalogModelIds(initial, provider)).toContain("fixture-model");
      const owner = preparedCatalog.getPublishedPreparedModelCatalogOwnerSnapshot({
        agentId: "main",
        config: cfg,
      });
      if (!owner) {
        throw new Error("Synthetic A catalog was not published");
      }
      expect(owner.isCurrent()).toBe(true);
      holdPreparation = true;
      record("b-replacement-started");
      replacement = preparedRuntime.refreshPreparedModelRuntimeSnapshots(owner.config, {
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        agentIds: new Set(["sibling"]),
        pluginMetadataSnapshot: owner.metadataSnapshot,
      });
      void replacement.catch(() => {});
      await withinTest(
        awaitGateBeforeSettlement(
          preparationEntered.promise,
          replacement,
          "Scoped replacement did not reach the synthetic preparation gate",
        ),
        signal,
      );
      expect(owner.isCurrent()).toBe(true);
      expect(
        preparedCatalog
          .getPublishedPreparedModelCatalogOwnerSnapshot({
            agentId: "main",
            config: owner.config,
          })
          ?.isCurrent(),
      ).toBe(true);

      const aCheckpoint = createDeferred();
      checkpoint = { scope: "main:provider-config", reached: aCheckpoint };
      const unseenA = request("a-unseen", "main", "provider-config");
      await withinTest(
        awaitGateBeforeSettlement(
          aCheckpoint.promise,
          unseenA,
          "Unseen A view settled without checking the replacement boundary",
        ),
        signal,
      );
      const retained = await withinTest(request("a-retained", "main", "configured"), signal);
      expect(retained.models).toEqual(initial.models);
      if (variant === "baseline") {
        expect(settled.has("a-unseen")).toBe(false);
        record("a-pending-after-retained-response");
      }

      observeB = true;
      const affectedB = request("b-affected", "sibling", "provider-config");
      await withinTest(
        awaitGateBeforeSettlement(
          bEntered.promise,
          affectedB,
          "Affected B view settled without entering runtime readiness",
        ),
        signal,
      );
      await withinTest(request("a-retained-checkpoint", "main", "configured"), signal);
      // Keep the cached-request schedule identical before observing the variant's outcome.
      if (variant === "candidate") {
        expect((await withinTest(unseenA, signal)).models).toEqual([]);
        record("a-settled-before-sibling-release");
      }
      expect(settled.has("a-unseen")).toBe(variant === "candidate");
      expect(settled.has("b-affected")).toBe(false);
      expect(heldResponses.size).toBeGreaterThan(0);
      record("b-released");
      releasePreparation();
      await withinTest(replacement, signal);
      record("b-replacement-completed");
      for (const result of await withinTest(Promise.all([unseenA, affectedB]), signal)) {
        // Provider-config lists authored inventory; this fixture authors no model rows.
        expect(result.models).toEqual([]);
      }
      const configured = await withinTest(
        request("a-after-replacement", "main", "configured"),
        signal,
      );
      expect(catalogModelIds(configured, provider)).toContain("fixture-model");
      expect(factoryCalls).toBeGreaterThan(0);
      if (variant === "candidate") {
        expect(catalogCalls).toBeGreaterThan(0);
      }
      completed = true;
      completedSamples.push({ variant, sample, requestDurationsMs, startupMs });
    } finally {
      checkpoint = undefined;
      observeB = false;
      releasePreparation();
      pendingSpy.mockRestore();
      factorySpy.mockRestore();
      readySpy.mockRestore();
      catalogSpy.mockRestore();
      await gateway?.close();
      await Promise.allSettled([...(replacement ? [replacement] : []), ...requests]);
      console.log(
        JSON.stringify({
          diagnostic: "models-list-scoped-replacement",
          completed,
          sample,
          variant,
          source: variant === "baseline" ? "dbf16e0e125e371297222746024c1a6829693d9d" : "candidate",
          factoryCalls,
          catalogCalls,
          startupMs,
          host: {
            load: initialLoad,
            cpu: process.cpuUsage(initialCpu),
            initialRss,
            finalRss: process.memoryUsage().rss,
          },
          agents: { a: "main", b: "sibling" },
          requestDurationsMs,
          events,
        }),
      );
    }
  },
);
