import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelCatalogTarget } from "../../../packages/gateway-protocol/src/index.js";
import { createGatewayMetadataObserver } from "../app/gateway-observers.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { clearModelCatalogCache, invalidateModelCatalogCache } from "./model-catalog-cache.ts";
import { loadModelCatalog, peekModelCatalog } from "./model-catalog-store.ts";

const catalog = { models: [{ id: "current", provider: "fixture", name: "Current" }] };
const fallback = { models: [{ id: "fallback", provider: "fixture", name: "Fallback" }] };
afterEach(() => vi.useRealTimers());

function fixture(target: ModelCatalogTarget = {}, advertised = true) {
  const request = createGatewayRequestMock(async () => fallback);
  const client = createTestGatewayClient(request);
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "alpha",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: [] },
      features: {
        methods: [],
        events: advertised ? ["models.snapshot", "models.snapshot.error"] : [],
      },
      snapshot: { sessionDefaults: { defaultAgentId: "alpha" } },
    },
  };
  const observer = createGatewayMetadataObserver(() => true);
  observer.captureTarget(target);
  observer.synchronize({ ...snapshot, client: null, hello: null, phase: "connecting" }, snapshot);
  const publish = (payload: unknown, event = "models.snapshot") =>
    observer.receive(
      {
        type: "event",
        event,
        payload,
      },
      snapshot,
    );
  return { client, request, snapshot, observer, publish, target };
}

it.each([{}, { agentId: "alpha" }, { agentId: "missing" }])(
  "joins the default-resolved handshake target %j without a client discovery request",
  async (target) => {
    const f = fixture(target);
    const result = loadModelCatalog(f.client, { agentId: "alpha" });
    await Promise.resolve();
    expect(f.request).not.toHaveBeenCalled();
    expect(
      f.publish({ target: { agentId: "foreign" }, scope: { agentId: "foreign" }, catalog }),
    ).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
    f.publish({ target, scope: { agentId: "alpha" }, catalog });
    expect(await result).toEqual(catalog);
    expect(f.request).not.toHaveBeenCalled();
  },
);

it("joins a negotiated target without an event-advertisement compatibility gate", async () => {
  const f = fixture({}, false);
  const pending = loadModelCatalog(f.client, { agentId: "alpha" });
  expect(f.request).not.toHaveBeenCalled();
  f.publish({ target: {}, scope: { agentId: "alpha" }, catalog });
  expect(await pending).toEqual(catalog);
  expect(f.request).not.toHaveBeenCalled();
});

it("reads unrelated agents and projections without waiting for a pending snapshot", async () => {
  const f = fixture({ agentId: "bravo" });
  await loadModelCatalog(f.client, { agentId: "charlie" });
  await loadModelCatalog(f.client, { agentId: "bravo", authProfileId: "personal:fixture" });
  await loadModelCatalog(f.client, { agentId: "bravo", sessionKey: "agent:bravo:other" });
  expect(f.request).toHaveBeenCalledTimes(3);
  f.publish({ target: f.target, scope: { agentId: "bravo" }, catalog });
});

it.each(["error", "partial", "invalidation"] as const)(
  "falls back to one shared request after %s",
  async (outcome) => {
    const f = fixture();
    const first = loadModelCatalog(f.client, { agentId: "alpha" });
    const second = loadModelCatalog(f.client, { agentId: "alpha" });
    if (outcome === "error") {
      f.publish(
        { target: {}, error: { code: "UNAVAILABLE", message: "not ready" } },
        "models.snapshot.error",
      );
    } else if (outcome === "partial") {
      f.publish({
        target: {},
        scope: { agentId: "alpha" },
        catalog: { ...catalog, refreshFailed: true },
      });
    } else if (outcome === "invalidation") {
      invalidateModelCatalogCache(f.client);
      f.publish({ target: {}, scope: { agentId: "alpha" }, catalog });
    }
    expect(await first).toEqual(fallback);
    expect(await second).toEqual(fallback);
    expect(f.request).toHaveBeenCalledTimes(1);
  },
);

it("keeps a cancelled reader from cancelling another and retires reconnect waiters", async () => {
  const f = fixture();
  const controller = new AbortController();
  const cancelled = loadModelCatalog(f.client, { agentId: "alpha", signal: controller.signal });
  const active = loadModelCatalog(f.client, { agentId: "alpha" });
  controller.abort();
  await expect(cancelled).rejects.toHaveProperty("name", "AbortError");
  f.publish({ target: {}, scope: { agentId: "alpha" }, catalog });
  expect(await active).toEqual(catalog);
  expect(f.request).not.toHaveBeenCalled();

  f.observer.synchronize(f.snapshot, { ...f.snapshot, hello: { ...f.snapshot.hello! } });
  const retired = loadModelCatalog(f.client, { agentId: "alpha" });
  clearModelCatalogCache(f.client);
  await expect(retired).rejects.toHaveProperty("name", "AbortError");
  f.publish({ target: {}, scope: { agentId: "alpha" }, catalog });
  expect(peekModelCatalog(f.client, { agentId: "alpha" })).toBeUndefined();
});

it("counts waiting against explicit budgets without timing out other readers", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const limited = loadModelCatalog(f.client, { agentId: "alpha", timeoutMs: 25 });
  const unlimited = loadModelCatalog(f.client, { agentId: "alpha", timeoutMs: null });
  const expired = expect(limited).rejects.toMatchObject({ timeoutMs: 25, requestSent: false });
  await vi.advanceTimersByTimeAsync(25);
  await expired;
  f.publish({ target: {}, scope: { agentId: "alpha" }, catalog });
  expect(await unlimited).toEqual(catalog);
  expect(f.request).not.toHaveBeenCalled();
});

it.each([undefined, null])(
  "preserves the browser model request's unbounded %s timeout while awaiting publication",
  async (timeoutMs) => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = loadModelCatalog(f.client, { agentId: "alpha", timeoutMs });
    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS + 1);
    expect(f.request).not.toHaveBeenCalled();
    f.publish({ target: {}, scope: { agentId: "alpha" }, catalog });
    expect(await pending).toEqual(catalog);
    expect(f.request).not.toHaveBeenCalled();
  },
);

it.each([
  { agentId: "alpha", sessionKey: "agent:alpha:saved" },
  { agentId: "alpha", shortId: "12345678", slugHint: "saved" },
])("joins saved-session publication %j without blocking another agent", async (target) => {
  const f = fixture(target);
  const scope = { agentId: "alpha", sessionKey: "agent:alpha:saved" };
  const pending = loadModelCatalog(f.client, scope);
  await loadModelCatalog(f.client, { agentId: "bravo", sessionKey: "agent:bravo:other" });
  expect(f.request).toHaveBeenCalledTimes(1);
  f.publish({ target, scope, catalog });
  expect(await pending).toEqual(catalog);
  expect(f.request).toHaveBeenCalledTimes(1);
});

it("passes only the remaining deadline to a fallback request", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = loadModelCatalog(f.client, { agentId: "alpha", timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(30);
  f.publish(
    { target: {}, error: { code: "UNAVAILABLE", message: "not ready" } },
    "models.snapshot.error",
  );
  expect(await pending).toEqual(fallback);
  expect(f.request).toHaveBeenCalledWith(
    "models.list",
    { agentId: "alpha", view: "configured" },
    {
      timeoutMs: 70,
      signal: expect.any(AbortSignal),
    },
  );
});

it.each([
  {
    target: { agentId: "alpha", shortId: "12345678" },
    requested: { agentId: "alpha", sessionKey: "agent:alpha:other" },
    published: { agentId: "alpha", sessionKey: "agent:alpha:saved" },
  },
  {
    target: { agentId: "bravo" },
    requested: { agentId: "alpha" },
    published: { agentId: "bravo" },
  },
])(
  "releases an unresolved candidate when the server publishes a different scope: $target",
  async ({ target, requested, published }) => {
    const f = fixture(target);
    const pending = loadModelCatalog(f.client, requested);
    expect(f.request).not.toHaveBeenCalled();
    f.publish({ target, scope: published, catalog });
    expect(await pending).toEqual(fallback);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(peekModelCatalog(f.client, published)).toEqual(catalog);
    expect(peekModelCatalog(f.client, requested)).toEqual(fallback);
  },
);
