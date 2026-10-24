import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../config/config.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type ConnectedGateway = Awaited<ReturnType<typeof startServerWithClient>>;

let gateway: ConnectedGateway;
let minimalGatewayEnv: ReturnType<typeof captureEnv> | undefined;
type MetadataRuntime = ReturnType<
  typeof import("./server-methods/chat-metadata-runtime.js").createGatewayChatMetadataRuntime
>;
let comparison: { baseline: MetadataRuntime; candidate: MetadataRuntime };
let variant: "baseline" | "candidate" = "candidate";
let sample: { refreshes: number; runtimeMs: number } | undefined;

beforeAll(async () => {
  minimalGatewayEnv = captureEnv(["OPENCLAW_TEST_MINIMAL_GATEWAY"]);
  // Minimal mode hides the production lifecycle's sticky-publication regression.
  setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
  await writeGatewayConfig(boundaryConfig());
  const runtimeModule = await import("./server-methods/chat-metadata-runtime.js");
  const { createGatewayChatMetadataRuntime: baselineFactory } =
    await import("./server-methods/chat-metadata-runtime.baseline.test-support.js");
  const candidateFactory = runtimeModule.createGatewayChatMetadataRuntime;
  // Diagnostic only: both real owners share the same published inputs and transport.
  const factory = vi
    .spyOn(runtimeModule, "createGatewayChatMetadataRuntime")
    .mockImplementation((options) => {
      comparison = {
        baseline: baselineFactory({ ...options, onChanged: undefined }),
        candidate: candidateFactory(options),
      };
      return {
        ...comparison.candidate,
        invalidate() {
          comparison.baseline.invalidate();
          comparison.candidate.invalidate();
        },
        fail(error) {
          comparison.baseline.fail(error);
          comparison.candidate.fail(error);
        },
        async refresh(options) {
          await comparison.baseline.refresh(options);
          await comparison.candidate.refresh(options);
        },
        async stop() {
          await Promise.all([comparison.baseline.stop(), comparison.candidate.stop()]);
        },
        async read(params) {
          const measured = sample;
          const started = performance.now();
          const original = params.withCurrent;
          try {
            return await comparison[variant].read({
              ...params,
              withCurrent: original
                ? (consume) => {
                    if (measured) {
                      measured.refreshes++;
                    }
                    return original(consume);
                  }
                : undefined,
            });
          } finally {
            if (measured) {
              measured.runtimeMs += performance.now() - started;
            }
          }
        },
      };
    });
  gateway = await startServerWithClient();
  factory.mockRestore();
  await gateway.server.startupSettled;
  await waitForGatewayStartup(gateway.port);
  await connectOk(gateway.ws);
  const { refreshPreparedModelRuntimeSnapshots } =
    await import("../agents/prepared-model-runtime.js");
  await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), { gatewayLifecycle: true });
  await expect(metadata()).resolves.toMatchObject({ ok: true });
}, 60_000);

afterAll(async () => {
  if (gateway) {
    gateway.ws.close();
    await gateway.server.close();
    gateway.envSnapshot.restore();
  }
  clearConfigCache();
  minimalGatewayEnv?.restore();
});

const boundaryConfig = (missingOwner = false) =>
  ({
    agents: {
      ownership: "explicit",
      defaults: {
        systemAgent: { agentId: "main" },
        model: { primary: "openai/gpt-boundary" },
        models: { "openai/gpt-boundary": {} },
      },
      entries: { main: {}, healthy: {}, ...(missingOwner ? { missing: {} } : {}) },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://openai.example.com/v1",
          models: [{ id: "gpt-boundary", name: "GPT Boundary" }],
        },
      },
    },
  }) as const;
const metadata = (agentId = "main") => rpcReq(gateway.ws, "chat.metadata", { agentId });
const unavailable = (message: string) => ({
  ok: false,
  error: { code: "UNAVAILABLE", message: expect.stringContaining(message) },
});

async function expectModels(
  method = "chat.metadata",
  params: Record<string, unknown> = { agentId: "main" },
) {
  const result = await rpcReq(gateway.ws, method, params);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.payload).toMatchObject({
    models: expect.arrayContaining([
      expect.objectContaining({ id: "gpt-boundary", provider: "openai" }),
    ]),
  });
}

async function writeGatewayConfig(config: Record<string, unknown>, resetRuntime = false) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  clearConfigCache();
  if (resetRuntime) {
    clearRuntimeConfigSnapshot();
  }
}

test("measures saved-session metadata refreshes through the real RPC", async () => {
  const sessionKey = "agent:main:metadata-comparison";
  const created = await rpcReq(gateway.ws, "sessions.create", {
    key: sessionKey,
    agentId: "main",
    label: "Synthetic metadata comparison",
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const request = async (includeModels: boolean) => {
    const id = randomUUID();
    const reply = onceMessage(gateway.ws, (message) => message.type === "res" && message.id === id);
    gateway.ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "chat.metadata",
        params: { sessionKey, includeModels },
      }),
    );
    return await reply;
  };
  const results: Array<{
    variant: typeof variant;
    cache: "cold" | "warm";
    includeModels: boolean;
    refreshes: number;
    runtimeMs: number;
    rpcMs: number;
    threadCpuUs: number;
  }> = [];
  try {
    for (const includeModels of [true, false]) {
      for (const cache of ["cold", "warm"] as const) {
        for (const side of ["baseline", "candidate"] as const) {
          variant = side;
          expect((await request(includeModels)).ok).toBe(true);
        }
        for (let pair = 0; pair < 6; pair++) {
          if (cache === "cold") {
            comparison.baseline.invalidate();
            comparison.candidate.invalidate();
            await comparison.baseline.refresh();
            await comparison.candidate.refresh();
          }
          const pairResults = [];
          const sides =
            pair % 2 === 0
              ? (["baseline", "candidate"] as const)
              : (["candidate", "baseline"] as const);
          for (const side of sides) {
            variant = side;
            sample = { refreshes: 0, runtimeMs: 0 };
            const cpu = process.threadCpuUsage();
            const start = performance.now();
            const response = await request(includeModels);
            const rpcMs = performance.now() - start;
            const used = process.threadCpuUsage(cpu);
            expect(response.ok, JSON.stringify(response)).toBe(true);
            pairResults.push(response.payload);
            results.push({
              variant,
              cache,
              includeModels,
              ...sample,
              rpcMs,
              threadCpuUs: used.user + used.system,
            });
            sample = undefined;
          }
          expect(pairResults[0]).toEqual(pairResults[1]);
          const [first, second] = results.slice(-2);
          expect(first!.refreshes - second!.refreshes).toBe(
            includeModels ? (first!.variant === "baseline" ? 1 : -1) : 0,
          );
        }
      }
    }
    console.log(
      "CHAT_METADATA_REFRESH_COMPARISON",
      JSON.stringify({
        source: "d355f2fd148dd68486d863aba8b510adfa8005c2",
        cacheScope: "metadata owner; shared dependencies warm",
        availableParallelism: availableParallelism(),
        loadAverage: loadavg(),
        samples: results,
      }),
    );
  } finally {
    sample = undefined;
    variant = "candidate";
  }
});

test("metadata RPCs isolate missing owners and preserve deferred admission and publication failures", async () => {
  const publicationEvents = await import("../agents/prepared-model-runtime.publication-events.js");
  // Config can expose an agent before its prepared owner exists; replay real published catch-up.
  await writeGatewayConfig(boundaryConfig(true), true);
  publicationEvents.notifyPreparedModelRuntimePublication({ phase: "published" });
  for (const method of ["chat.metadata", "models.list"] as const) {
    await expectModels(method);
  }

  await writeGatewayConfig(boundaryConfig(), true);
  await expectModels();

  // Reset the published runtime between boundary cases without restarting the Gateway.
  const { refreshPreparedModelRuntimeSnapshots } =
    await import("../agents/prepared-model-runtime.js");
  await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), { gatewayLifecycle: true });
  await expect(metadata()).resolves.toMatchObject({ ok: true });

  const modelsListResult = await import("./server-methods/models-list-result.js");
  const prepareModelsListResult = modelsListResult.prepareModelsListResult;
  const projectionSpy = vi
    .spyOn(modelsListResult, "prepareModelsListResult")
    .mockImplementation(async (params) => {
      if (params.agentId === "main") {
        throw new Error("configured model catalog unavailable");
      }
      return prepareModelsListResult(params);
    });

  publicationEvents.notifyPreparedModelRuntimePublication({ phase: "invalidated" });
  publicationEvents.notifyPreparedModelRuntimePublication({ phase: "published" });
  expect(await metadata()).toMatchObject(unavailable("configured model catalog unavailable"));
  await expect(metadata("healthy")).resolves.toMatchObject({ ok: true });

  projectionSpy.mockRestore();
  await expect(metadata()).resolves.toMatchObject({ ok: true });

  const {
    createAgentDatabaseInspectionRefusal,
    preparePendingAgentDatabase,
    recordAgentDatabaseAdmissions,
  } = await import("../state/agent-database-admission.js");
  const { resolveOpenClawAgentSqlitePath } = await import("../state/openclaw-agent-db.paths.js");
  const env = { ...process.env };
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: "main",
    paths: [resolveOpenClawAgentSqlitePath({ agentId: "main", env })],
    pending: true,
    reason: "Synthetic deferred startup admission",
  });
  const releasePublication = createDeferred();
  let latePublication: Promise<void> | undefined;
  recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
  try {
    await preparePendingAgentDatabase(refusal, { env, assertCurrent() {} }, async () => {
      await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), {
        agentIds: new Set(["main"]),
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
      });
      // Catalog completion retains the publisher's borrow after admission has settled.
      latePublication = releasePublication.promise.then(() => {
        publicationEvents.notifyPreparedModelRuntimePublication({
          phase: "catalog-published",
          modelFactsChanged: false,
          refreshStatusChanged: true,
        });
      });
    });
    await expect(metadata()).resolves.toMatchObject({ ok: true });
    releasePublication.resolve();
    await latePublication;
    for (const [method, params] of [
      ["chat.metadata", { agentId: "main" }],
      ["models.list", { agentId: "main", view: "configured", preparedOnly: true }],
    ] as const) {
      await expectModels(method, params);
    }
  } finally {
    releasePublication.resolve();
    await latePublication;
    recordAgentDatabaseAdmissions([], { env, source: "startup" });
  }

  publicationEvents.notifyPreparedModelRuntimePublication({ phase: "invalidated" });
  publicationEvents.notifyPreparedModelRuntimePublication({
    phase: "failed",
    error: new Error("prepared model owner publication failed"),
  });
  for (const agentId of ["main", "healthy"]) {
    expect(await metadata(agentId)).toMatchObject(
      unavailable("prepared model owner publication failed"),
    );
  }
});
