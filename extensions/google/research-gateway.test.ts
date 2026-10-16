import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as authRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { jsonResponse, mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(research?: Record<string, unknown>) {
  const register = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();
  const api = createTestPluginApi({
    id: "google",
    runtime: createPluginRuntimeMock(),
    pluginConfig: research ? { research } : {},
    registerGatewayMethod: register,
  });
  plugin.register(api);
  const registration = register.mock.calls.find(([method]) => method === "google.research.v1");
  if (!registration) {
    throw new Error("Research method not registered");
  }
  const current = vi.fn();
  const signal = new AbortController().signal;
  const borrow = () => ({ signal, assertCurrent: current, release() {} });
  const authority = {
    target: {
      sessionKey: "agent:main:research-fixture",
      agentId: "main",
      sessionId: "generation-1",
    },
    sandboxRequired: false,
    assertCurrent: current,
    retain: borrow,
    retainSession: borrow,
    release() {},
  };
  return {
    api,
    current,
    policy: registration[2],
    async request(request: unknown) {
      const respond = vi.fn();
      // The host prepares authority; this fixture exercises the registered plugin boundary.
      await registration[1]({
        req: { type: "req", id: "research-fixture", method: "google.research.v1" },
        client: null,
        isWebchatConnect: () => false,
        get context(): GatewayRequestHandlerOptions["context"] {
          throw new Error("Research adapter unexpectedly accessed raw Gateway context");
        },
        params: { sessionKey: authority.target.sessionKey, agentId: "main", request },
        sessionAccessAuthority: authority,
        signal,
        respond,
      });
      return respond.mock.calls[0]?.[1];
    },
  };
}

describe("registered Google managed-research RPC", () => {
  it("requires explicit activation and rejects unsupported versions before auth or HTTP", async () => {
    const auth = vi.spyOn(authRuntime, "resolveApiKeyForProvider");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const config of [
      undefined,
      { enabled: false, profileId: "google:research" },
      { enabled: true },
    ]) {
      const entry = fixture(config);
      expect(await entry.request({ version: 1, action: "describe" })).toMatchObject({
        ok: false,
        state: "blocked",
      });
    }
    const entry = fixture({ enabled: true, profileId: "google:research" });
    expect(entry.policy).toMatchObject({
      profileAccess: "required",
      sessionAccess: { mode: "write", requiredTool: "deep_research", allowOwnSessionScope: true },
    });
    expect(await entry.request({ version: 2, action: "start", question: "River" })).toMatchObject({
      ok: false,
    });
    expect(await entry.request({ version: 1, action: "describe" })).toMatchObject({
      ok: true,
      value: { kind: "managed-research", authModes: ["api-key"] },
    });
    expect(auth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes an activated versioned request through the real provider adapter", async () => {
    mockPinnedHostnameResolution();
    const auth = vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      mode: "api-key",
      apiKey: "synthetic-google-key",
      profileId: "google:research",
      source: "profile",
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        id: "research-fixture",
        status: "completed",
        steps: [
          { type: "model_output", content: [{ type: "text", text: "The provider report." }] },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const entry = fixture({ enabled: true, profileId: "google:research" });
    expect(
      await entry.request({ version: 1, action: "start", question: "Research the river." }),
    ).toMatchObject({
      version: 1,
      ok: true,
      value: {
        state: "completed",
        report: "The provider report.",
        handle: { interactionId: "research-fixture", profileId: "google:research" },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(
      await entry.request({
        version: 1,
        action: "poll",
        handle: { interactionId: "research-fixture", profileId: "google:another" },
      }),
    ).toMatchObject({ ok: false, state: "blocked" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not publish a report after authority is revoked during the provider request", async () => {
    mockPinnedHostnameResolution();
    vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      mode: "api-key",
      apiKey: "synthetic-google-key",
      profileId: "google:research",
      source: "profile",
    });
    const entry = fixture({ enabled: true, profileId: "google:research" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        entry.current.mockImplementation(() => {
          throw new Error("retired");
        });
        return jsonResponse({
          id: "research-fixture",
          status: "completed",
          steps: [{ type: "model_output", content: [{ type: "text", text: "Do not publish." }] }],
        });
      }),
    );
    const response = await entry.request({ version: 1, action: "start", question: "River" });
    expect(response).toMatchObject({ ok: false, state: "indeterminate" });
    expect(JSON.stringify(response)).not.toContain("Do not publish.");
  });
});
