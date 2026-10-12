import { threadId } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import { runProviderPluginAuthMethodUnpersisted } from "../src/plugins/provider-auth-method.js";
import { createNonExitingRuntime } from "../src/runtime.js";
import { acquireTestPortBlock } from "../src/test-utils/port-claims.js";
import { WizardSession } from "../src/wizard/session.js";

const guardedFetch = vi.hoisted(() => vi.fn());
const loopback = vi.hoisted<{
  port: number;
  boundPorts: number[];
  trace: Array<Record<string, unknown>>;
}>(() => ({
  port: 0,
  boundPorts: [],
  trace: [],
}));
const record = vi.hoisted(() => (stage: string, details: Record<string, unknown> = {}) => {
  const sockets: Array<{ state: string; inode: string }> = [];
  if (process.platform === "linux") {
    const { readFileSync } = process.getBuiltinModule("node:fs");
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try {
        for (const row of readFileSync(table, "utf8").trim().split("\n").slice(1)) {
          const fields = row.trim().split(/\s+/u);
          const state = fields[3];
          const inode = fields[9];
          if (
            state &&
            inode &&
            Number.parseInt(fields[1]?.split(":")[1] ?? "", 16) === loopback.port
          ) {
            sockets.push({ state, inode });
          }
        }
      } catch (error) {
        details.socketReadError =
          error instanceof Error && "code" in error ? error.code : "unknown";
      }
    }
  }
  loopback.trace.push({ stage, at: performance.now(), sockets, ...details });
});
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...actual,
    startProviderOAuthLoopbackCallbackServer: async (
      params: Parameters<typeof actual.startProviderOAuthLoopbackCallbackServer>[0],
    ) => {
      const redirectUrl = new URL(params.redirectUrl);
      redirectUrl.port = String(loopback.port);
      record("callback-start", { port: loopback.port, aborted: params.signal?.aborted });
      params.signal?.addEventListener("abort", () => record("callback-aborted"), { once: true });
      const server = await actual
        .startProviderOAuthLoopbackCallbackServer({ ...params, redirectUrl })
        .catch((error: unknown) => {
          record("callback-start-failed", {
            code: error instanceof Error && "code" in error ? error.code : "unknown",
          });
          throw error;
        });
      loopback.boundPorts.push(Number(redirectUrl.port));
      record("callback-ready");
      return {
        ...server,
        close: async () => {
          record("callback-close-requested");
          await server.close();
          record("callback-close-settled");
        },
      };
    },
  };
});

it("releases the SIWC callback port when OAuth expires before the wizard note is acknowledged", async () => {
  const method = buildOpenAIProvider().auth.find((entry) => entry.id === "siwc");
  if (!method) {
    throw new Error("OpenAI did not register its SIWC method");
  }
  // Retain ownership across the close/rebind gap; a leaked listener must still fail.
  const portClaim = await acquireTestPortBlock({ offsets: [0] });
  loopback.port = portClaim.port;
  loopback.boundPorts = [];
  loopback.trace = [];
  record("port-claimed", { port: loopback.port, pid: process.pid, threadId });
  const timeout = new AbortController();
  const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
  const start = () =>
    new WizardSession(async (prompter, signal) => {
      await runProviderPluginAuthMethodUnpersisted({
        config: {},
        runtime: createNonExitingRuntime(),
        method,
        prompter,
        signal,
        existingProfiles: [],
        isRemote: false,
      });
    });
  const session = start();
  let retry: WizardSession | undefined;
  try {
    const pending = await session.next();
    expect(pending.step).toMatchObject({
      type: "note",
      externalUrl: expect.stringContaining("/api/accounts/authorize?"),
    });
    expect(timeoutSignal).toHaveBeenCalledWith(5 * 60_000);
    // Expire OAuth while the longer-lived wizard still awaits acknowledgement.
    timeout.abort(new DOMException("Sign-in timed out", "TimeoutError"));
    // Retry only after the expired runner has released its callback listener.
    await session.whenSettled();
    record("expired-wizard-settled");
    expect(await session.next()).toMatchObject({
      done: true,
      status: "error",
      error: "Login cancelled",
    });

    retry = start();
    record("retry-started");
    // SIWC publishes this note only after its callback listener has bound successfully.
    const retried = await retry.next();
    expect(retried, retry.getError()).toMatchObject({
      done: false,
      step: {
        type: "note",
        externalUrl: expect.stringContaining("/api/accounts/authorize?"),
      },
    });
    expect(loopback.port).toBeGreaterThan(0);
    expect(loopback.boundPorts).toEqual([loopback.port, loopback.port]);
    expect(guardedFetch).not.toHaveBeenCalled();
  } finally {
    record("test-cleanup");
    try {
      session.cancel();
      retry?.cancel();
      await Promise.all([session.whenSettled(), retry?.whenSettled()]);
      timeoutSignal.mockRestore();
      await portClaim.release();
    } finally {
      console.error("[siwc-callback-diagnostic]", JSON.stringify(loopback.trace));
    }
  }
});
