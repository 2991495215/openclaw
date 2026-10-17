import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasAvailableAuthForProvider } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { verifySystemAgentInferenceWithFallback } from "./inference-fallback.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import { verifySetupInference, type VerifySetupInferenceResult } from "./setup-inference.js";

vi.mock("../agents/model-auth.js", () => ({ hasAvailableAuthForProvider: vi.fn() }));
vi.mock("./inference-route.js", () => ({ resolveSystemAgentConfiguredRouteFromConfig: vi.fn() }));
vi.mock("./setup-inference.js", () => ({ verifySetupInference: vi.fn() }));

beforeEach(() => {
  vi.mocked(hasAvailableAuthForProvider).mockReset().mockResolvedValue(true);
  vi.mocked(resolveSystemAgentConfiguredRouteFromConfig).mockReset();
  vi.mocked(verifySetupInference).mockReset();
});

const runtime = {} as RuntimeEnv;
const config: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "zeta/model" },
      systemAgent: { agentId: "requester" },
    },
    entries: {
      requester: { model: "zeta/model" },
      beta: { model: "beta/model" },
      alpha: { model: "alpha/model" },
    },
  },
};
const verifyConfigured = (cfg: OpenClawConfig) =>
  verifySystemAgentInferenceWithFallback({
    requestingAgentId: "requester",
    runtime,
    deps: { readConfig: async () => cfg },
  });
const success = (modelRef: string) => ({ ok: true, modelRef, latencyMs: 1, binding: {} }) as never;

function route(agentId: string, provider: string): SystemAgentConfiguredRoute {
  return {
    runner: "embedded",
    agentHarnessRuntimeOverride: "openclaw",
    runConfig: {},
    sourceConfig: {},
    modelLabel: `${provider}/model`,
    provider,
    model: "model",
    agentDir: `/tmp/${agentId}`,
    agentId,
  };
}

function fallbackConfig(agentIds: string[], systemAgent?: { agentId: string }): OpenClawConfig {
  return {
    agents: {
      ...(systemAgent ? { defaults: { systemAgent } } : {}),
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
    },
  };
}

async function verifyAfterFailure(
  failure: Extract<VerifySetupInferenceResult, { ok: false }>,
  includeBeta: boolean,
  successfulAgentId: "alpha-other" | "beta",
) {
  const attempts: string[] = [];
  const cfg = fallbackConfig(["requester", "alpha-other", ...(includeBeta ? ["beta"] : [])]);
  vi.mocked(resolveSystemAgentConfiguredRouteFromConfig).mockImplementation(async (_cfg, agentId) =>
    route(agentId!, agentId === "beta" ? "beta" : "alpha"),
  );
  vi.mocked(verifySetupInference).mockImplementation(async ({ agentId }) => {
    attempts.push(agentId!);
    return agentId === successfulAgentId
      ? success(agentId === "beta" ? "beta/model" : "alpha/model")
      : { ...failure };
  });
  const result = await verifyConfigured(cfg);
  return { result, attempts };
}

describe("system-agent inference fallback", () => {
  it("does not claim providers are unconfigured when no route can be verified", async () => {
    vi.mocked(resolveSystemAgentConfiguredRouteFromConfig).mockResolvedValue(null);
    const result = await verifySystemAgentInferenceWithFallback({
      runtime,
      deps: { readConfig: async () => ({}) },
    });

    expect(result).toEqual({
      ok: false,
      status: "unknown",
      error: "OpenClaw could not verify a usable inference route. Check model setup and try again.",
    });
  });

  it("tries the system-agent route first, then authenticated providers by provider id", async () => {
    const attempts: string[] = [];
    const verify = vi.fn(async ({ agentId }: { agentId: string }) => {
      attempts.push(agentId);
      return agentId === "beta"
        ? ({ ok: true, modelRef: "beta/model", latencyMs: 1, binding: {} } as never)
        : ({ ok: false, status: "unavailable", error: "down" } as const);
    });

    vi.mocked(resolveSystemAgentConfiguredRouteFromConfig).mockImplementation(
      async (_cfg, agentId) => route(agentId!, agentId === "requester" ? "zeta" : agentId!),
    );
    vi.mocked(verifySetupInference).mockImplementation(verify as never);
    const result = await verifySystemAgentInferenceWithFallback({
      runtime,
      deps: { readConfig: async () => config },
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "alpha", "beta"]);
  });

  it("retains the implicit main fallback for a pre-roster config", async () => {
    const attempts: string[] = [];
    vi.mocked(resolveSystemAgentConfiguredRouteFromConfig).mockImplementation(
      async (_cfg, agentId) => route(agentId!, agentId!),
    );
    vi.mocked(verifySetupInference).mockImplementation(async ({ agentId }) => {
      attempts.push(agentId!);
      return agentId === "main"
        ? success("main/model")
        : ({ ok: false, status: "unavailable", error: "down" } as const);
    });
    const result = await verifyConfigured({});

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "main"]);
  });

  it("skips unauthenticated fallback providers", async () => {
    const attempts: string[] = [];
    vi.mocked(resolveSystemAgentConfiguredRouteFromConfig).mockImplementation(
      async (_cfg, agentId) => route(agentId!, agentId === "requester" ? "zeta" : agentId!),
    );
    vi.mocked(hasAvailableAuthForProvider).mockImplementation(
      async ({ provider }) => provider !== "alpha",
    );
    vi.mocked(verifySetupInference).mockImplementation(async ({ agentId }) => {
      attempts.push(agentId!);
      return { ok: false, status: "unavailable", error: "down" };
    });
    await verifyConfigured(config);

    expect(attempts).toEqual(["requester", "beta"]);
  });

  it("uses a later authenticated route for one fallback provider", async () => {
    const attempts: string[] = [];
    const duplicateProviderConfig = fallbackConfig(["requester", "alpha-bad", "alpha-good"]);

    vi.mocked(resolveSystemAgentConfiguredRouteFromConfig).mockImplementation(
      async (_cfg, agentId) => route(agentId!, agentId === "requester" ? "zeta" : "alpha"),
    );
    vi.mocked(hasAvailableAuthForProvider).mockImplementation(
      async ({ agentDir }) => agentDir?.endsWith("alpha-good") === true,
    );
    vi.mocked(verifySetupInference).mockImplementation(async ({ agentId }) => {
      attempts.push(agentId!);
      return agentId === "alpha-good"
        ? success("alpha/model")
        : ({ ok: false, status: "unavailable", error: "down" } as const);
    });
    const result = await verifyConfigured(duplicateProviderConfig);

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "alpha-good"]);
  });

  it.each([
    ["auth", "stale key", false, "alpha-other"],
    ["rate_limit", "429", false, "alpha-other"],
    ["format", "bad response", true, "alpha-other"],
    ["unavailable", "down", true, "beta"],
  ] as const)(
    "retries %s at the correct owner scope",
    async (status, error, includeBeta, successfulAgentId) => {
      const { result, attempts } = await verifyAfterFailure(
        { ok: false, status, error },
        includeBeta,
        successfulAgentId,
      );
      expect(result.ok).toBe(true);
      expect(attempts).toEqual(["requester", successfulAgentId]);
    },
  );

  it("does not fail over on owner or identity uncertainty", async () => {
    const verify = vi.fn(
      async () => ({ ok: false, status: "unknown", error: "winner identity uncertain" }) as const,
    );

    vi.mocked(resolveSystemAgentConfiguredRouteFromConfig).mockImplementation(
      async (_cfg, agentId) => route(agentId!, agentId === "requester" ? "zeta" : agentId!),
    );
    vi.mocked(verifySetupInference).mockImplementation(verify);
    const result = await verifyConfigured(
      fallbackConfig(["requester", "beta", "alpha"], { agentId: "requester" }),
    );

    expect(result).toEqual({
      ok: false,
      status: "unknown",
      error: "winner identity uncertain",
    });
    expect(verify).toHaveBeenCalledOnce();
  });
});
