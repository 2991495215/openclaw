import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGatewayResume, runGatewaySuspend } from "./suspend-cli.js";

const { callGateway, runtime, sleep } = vi.hoisted(() => ({
  callGateway: vi.fn(),
  runtime: { log: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
  sleep: vi.fn(),
}));
vi.mock("../gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: callGateway,
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: runtime,
}));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: sleep,
}));

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const readyResult = {
  status: "ready" as const,
  suspensionId: "suspension-1",
  expiresAtMs: Date.parse("2026-08-11T12:00:00.000Z"),
  activeCount: 0,
  blockers: [],
};

const busyResult = {
  status: "busy" as const,
  reason: "active-work" as const,
  retryAfterMs: 200,
  activeCount: 1,
  blockers: [{ kind: "root-request" as const, count: 1, message: "1 active request" }],
};

describe("gateway suspend CLI", () => {
  it("prints a ready lease without exposing remote credentials in the resume hint", async () => {
    callGateway.mockResolvedValue(readyResult);
    const rpcOpts = { url: "wss://gateway.example:19444", token: "opaque-credential" };

    await runGatewaySuspend({ rpcOpts, waitSeconds: 0 });

    expect(callGateway).toHaveBeenCalledWith(
      "gateway.suspend.prepare",
      rpcOpts,
      { requestId: expect.stringMatching(/^cli-[0-9a-f]{8}$/u) },
      { defaultTimeoutMs: 10_000, sharedStateMode: "read-only" },
    );
    expect(callGateway).toHaveBeenCalledOnce();
    expect(runtime.log).toHaveBeenCalledWith("Gateway suspension prepared.");
    expect(runtime.log).toHaveBeenCalledWith("Suspension ID: suspension-1");
    expect(runtime.log).toHaveBeenCalledWith(
      `Expires: 2026-08-11T12:00:00.000Z (${readyResult.expiresAtMs} ms)`,
    );
    expect(runtime.log).toHaveBeenCalledWith("Resume with: openclaw gateway resume suspension-1");
  });

  it("rejects whitespace-only wait before acquiring a lease", async () => {
    callGateway.mockResolvedValue(readyResult);

    await expect(runGatewaySuspend({ rpcOpts: {}, waitSeconds: " \t\n" })).rejects.toThrow(
      "--wait must be a non-negative number of seconds",
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "named profile and custom local port",
      rpcOpts: { localPortOverride: 18999 },
      profile: "work",
      container: "",
      command: "openclaw --profile work gateway resume suspension-1 --port 18999",
    },
    {
      name: "container takes precedence over profile",
      rpcOpts: { localPortOverride: 18999 },
      profile: "work",
      container: "demo",
      command: "openclaw --container demo gateway resume suspension-1 --port 18999",
    },
  ])(
    "prints a correctly scoped resume hint for $name",
    async ({ rpcOpts, profile, container, command }) => {
      vi.stubEnv("OPENCLAW_PROFILE", profile);
      vi.stubEnv("OPENCLAW_CONTAINER_HINT", container);
      callGateway.mockResolvedValue(readyResult);
      await runGatewaySuspend({ rpcOpts });

      expect(runtime.log).toHaveBeenCalledWith(`Resume with: ${command}`);
    },
  );

  it("reports blockers without polling when --wait is omitted", async () => {
    callGateway.mockResolvedValue(busyResult);

    await expect(runGatewaySuspend({ rpcOpts: {}, requestId: "host-operation" })).rejects.toThrow(
      "Gateway suspension is busy (active-work; 1 active).\nBlockers:\n- 1 active request\nRetry later or use --wait <seconds>.",
    );
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("polls with one stable request id until the Gateway is ready", async () => {
    callGateway.mockResolvedValueOnce(busyResult).mockResolvedValueOnce(readyResult);
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    sleep.mockImplementation(async (delayMs: number) => {
      now += delayMs;
    });

    await runGatewaySuspend({ rpcOpts: {}, requestId: "host-operation", waitSeconds: "2" });

    expect(sleep).toHaveBeenCalledExactlyOnceWith(200);
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(callGateway.mock.calls.map((call) => call[2])).toEqual([
      { requestId: "host-operation" },
      { requestId: "host-operation" },
    ]);
  });

  it("emits the latest busy result and exits nonzero in JSON mode", async () => {
    callGateway.mockResolvedValue(busyResult);
    await runGatewaySuspend({ rpcOpts: { json: true }, requestId: "host-operation", json: true });

    expect(runtime.writeJson).toHaveBeenCalledWith({
      ...busyResult,
      requestId: "host-operation",
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("never issues another prepare after a sleep overshoots the deadline", async () => {
    let now = 1_000;
    callGateway.mockResolvedValue(busyResult);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    sleep.mockImplementation(async () => {
      // A lagging clock can wake far past the advertised --wait window.
      now += 10_000;
    });

    await expect(
      runGatewaySuspend({ rpcOpts: {}, requestId: "host-operation", waitSeconds: "0.2" }),
    ).rejects.toThrow(
      "Gateway suspension is busy (active-work; 1 active).\nBlockers:\n- 1 active request\nTimed out waiting for the Gateway to become idle.",
    );
    expect(callGateway).toHaveBeenCalledOnce();
  });
});

describe("gateway resume CLI", () => {
  it.each([
    { resumed: true, message: "Gateway resumed." },
    {
      resumed: false,
      message:
        "No matching suspension was held (lease already expired or resumed); gateway is running.",
    },
  ])("prints the resumed=$resumed outcome", async ({ resumed, message }) => {
    callGateway.mockResolvedValue({ ok: true, status: "running", resumed });

    await runGatewayResume({ rpcOpts: {}, suspensionId: "suspension-1" });

    expect(callGateway).toHaveBeenCalledExactlyOnceWith(
      "gateway.suspend.resume",
      {},
      { suspensionId: "suspension-1" },
      { defaultTimeoutMs: 10_000, sharedStateMode: "read-only" },
    );
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(message);
  });
});
