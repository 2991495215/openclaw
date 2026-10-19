// Extension shared tests cover plugin-safe shared runtime helpers and proxy configuration.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const createAmbientNodeProxyAgentMock = vi.hoisted(() => vi.fn(() => ({ proxy: true })));
const hasAmbientNodeProxyConfiguredMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("@openclaw/proxyline", () => ({
  createAmbientNodeProxyAgent: createAmbientNodeProxyAgentMock,
  hasAmbientNodeProxyConfigured: hasAmbientNodeProxyConfiguredMock,
}));

import {
  buildPassiveChannelStatusSummary,
  buildPassiveProbedChannelStatusSummary,
  resolveAmbientNodeProxyAgent,
} from "./extension-shared.js";

interface StatusDetails {
  providerLabel: string;
  configured: boolean;
  running: boolean;
}

describe("passive channel summary contracts", () => {
  it.each([
    { identity: "user", mode: "http", expected: { postAs: "user", signingSecretSource: "none" } },
    { identity: "user", mode: "socket", expected: { postAs: "user", appTokenSource: "none" } },
    {
      identity: "bot",
      mode: "socket",
      expected: { botTokenSource: "none", appTokenSource: "none" },
    },
  ])(
    "supports async status adapters with $identity/$mode extras",
    async ({ identity, mode, expected }) => {
      const buildChannelSummary: () => Promise<Record<string, unknown>> = async () =>
        buildPassiveProbedChannelStatusSummary(
          {},
          identity === "user"
            ? {
                postAs: "user",
                ...(mode === "http" ? { signingSecretSource: "none" } : { appTokenSource: "none" }),
              }
            : { botTokenSource: "none", appTokenSource: "none" },
        );
      expect(await buildChannelSummary()).toMatchObject(expected);
    },
  );

  it("accepts probe-bearing literals without adding probe fields to base summaries", () => {
    const summary = buildPassiveChannelStatusSummary({ probe: { ok: true }, lastProbeAt: 3 });
    expectTypeOf(summary).toMatchTypeOf<{
      configured: boolean;
      running: boolean;
      lastStartAt: number | null;
      lastStopAt: number | null;
      lastError: string | null;
    }>();
    expectTypeOf(summary).not.toHaveProperty("probe");
    expect(summary).toEqual({
      configured: false,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    });
  });

  it.each([
    { build: buildPassiveChannelStatusSummary, probe: {} },
    {
      build: buildPassiveProbedChannelStatusSummary,
      probe: { probe: { ok: true }, lastProbeAt: 3 },
    },
  ])("preserves named object extras and lifecycle precedence", ({ build, probe }) => {
    const extra: StatusDetails = { providerLabel: "demo", configured: true, running: true };
    const summary = build({ configured: false, lastStartAt: 1, ...probe }, extra);
    expectTypeOf(summary.providerLabel).toEqualTypeOf<string>();
    expect(summary).toEqual({
      configured: true,
      providerLabel: "demo",
      running: false,
      lastStartAt: 1,
      lastStopAt: null,
      lastError: null,
      ...probe,
    });
  });
});

describe("resolveAmbientNodeProxyAgent", () => {
  const envKeys = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_CA_FILE",
  ] as const;
  const tempDirs: string[] = [];

  beforeEach(() => {
    createAmbientNodeProxyAgentMock.mockClear();
    hasAmbientNodeProxyConfiguredMock.mockClear();
    hasAmbientNodeProxyConfiguredMock.mockReturnValue(true);
    for (const key of envKeys) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  function writeTempCa(contents: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-shared-proxy-ca-"));
    tempDirs.push(dir);
    const caFile = path.join(dir, "proxy-ca.pem");
    writeFileSync(caFile, contents, "utf8");
    return caFile;
  }

  it("adds managed proxy CA trust to ambient Node proxy agents", async () => {
    const caFile = writeTempCa("extension-shared-managed-proxy-ca");
    vi.stubEnv("https_proxy", "https://proxy.example:8443");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);

    const agent = await resolveAmbientNodeProxyAgent<{ proxy: true }>();

    expect(agent).toEqual({ proxy: true });
    expect(createAmbientNodeProxyAgentMock).toHaveBeenCalledWith({
      protocol: "https",
      proxyTls: { ca: "extension-shared-managed-proxy-ca" },
    });
  });
});
