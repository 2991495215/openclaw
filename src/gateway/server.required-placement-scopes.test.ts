import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import * as sessionChangeEvent from "./server-methods/session-change-event.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import * as placementDispatch from "./worker-environments/placement-dispatch.js";
import * as placementLifecycleStore from "./worker-environments/placement-lifecycle-store.js";
import * as workerEnvironmentService from "./worker-environments/service.js";

installGatewayTestHooks({ scope: "suite" });
const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test.each([false, true])(
  "session writers read only requested placement policy over authenticated RPC (required=%s)",
  async (required) => {
    const origin = "https://control.example.invalid";
    const email = "writer@example.invalid";
    const auth: GatewayAuthConfig = {
      mode: "trusted-proxy",
      identityScopes: { [email]: ["operator.sessions.write"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
        allowUsers: [email],
      },
    };
    testState.gatewayAuth = auth;
    testState.gatewayControlUi = { allowedOrigins: [origin] };
    await writeConfigFile({
      gateway: { auth, trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: [origin] } },
      ...(required
        ? {
            cloudWorkers: {
              requiredProfile: "dedicated",
              profiles: {
                dedicated: {
                  provider: "device",
                  settings: { device: "paired", inference: "worker" },
                },
              },
            },
          }
        : {}),
    });
    if (required) {
      vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
    }
    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, {
        origin,
        "x-forwarded-user": email,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
      });
      try {
        const connected = await connectReq(ws, {
          prePairDevice: true,
          client: CONTROL_UI_CLIENT,
          browserOrigin: origin,
          skipDefaultAuth: true,
          scopes: ["operator.sessions.write"],
          deviceIdentityPath: path.join(temps.make("policy-writer-"), "device.sqlite"),
        });
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        expect((connected.payload as HelloOk).auth.scopes).not.toContain("operator.write");
        const self = await rpcReq<{ profile: { id: string } }>(ws, "users.self", {});
        expect(self.ok, JSON.stringify(self.error)).toBe(true);
        expect(self.payload?.profile.id).toBeTruthy();
        for (const params of [{}, { runtimeId: "openclaw" }]) {
          const inventory = await rpcReq(ws, "environments.list", params);
          expect(inventory.ok).toBe(false);
          expect(inventory.error?.message).toMatch(/missing scope/);
        }
        const listed = await rpcReq<{ sessionPlacement: unknown }>(ws, "agents.list", {
          includeSessionPlacement: true,
        });
        expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
        expect(listed.payload?.sessionPlacement).toEqual(
          required
            ? {
                requiredProfile: {
                  id: "dedicated",
                  providerId: "device",
                  executionModes: ["worker-turn"],
                  inference: "worker",
                },
              }
            : {},
        );
        const ordinary = await rpcReq(ws, "agents.list", {});
        expect(ordinary.ok).toBe(true);
        expect(ordinary.payload).not.toHaveProperty("sessionPlacement");
      } finally {
        ws.close();
      }
    });
  },
);

test("required placement survives disconnect but stops setup when committed caller authority ends", async () => {
  const startedAt = performance.now();
  let scenario = "setup";
  const trace = (stage: string) => {
    console.error(
      `[required-placement] ${Math.round(performance.now() - startedAt)}ms ${scenario}: ${stage}`,
    );
  };
  trace("test entered");
  const origin = "https://control.example.invalid";
  const admin = "admin@example.invalid";
  const writers = {
    disconnect: "disconnect@example.invalid",
    scope: "scope@example.invalid",
    profile: "profile@example.invalid",
  };
  const auth: GatewayAuthConfig = {
    mode: "trusted-proxy",
    identityScopes: {
      [admin]: ["operator.admin"],
      ...Object.fromEntries(
        Object.values(writers).map((email) => [email, ["operator.sessions.write"]]),
      ),
    },
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
      allowUsers: [admin, ...Object.values(writers)],
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    gateway: { auth, trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: [origin] } },
    cloudWorkers: {
      requiredProfile: "dedicated",
      profiles: {
        dedicated: { provider: "device", settings: { device: "paired", inference: "worker" } },
      },
    },
  });
  trace("config written");
  vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");

  // Observe the production service's provider-side setup entry points without replacing them.
  const setupCalls: string[] = [];
  const dispatchErrors: string[] = [];
  let dispatchSettled: Promise<unknown> | undefined;
  const createDispatch = placementDispatch.createWorkerPlacementDispatchService;
  vi.spyOn(placementDispatch, "createWorkerPlacementDispatchService").mockImplementation(
    (options) => {
      const service = createDispatch({
        ...options,
        runLocalBarrier: async (params) => {
          trace("local barrier started");
          const placement = await options.runLocalBarrier(params);
          trace(`local barrier returned ${placement.state}`);
          const current = hold;
          if (current?.afterAcknowledgment && placement.state === "requested") {
            hold = undefined;
            trace("post-acknowledgment hold committed");
            current.committed.resolve();
            await current.resume;
            trace("post-acknowledgment hold resumed");
          }
          return placement;
        },
      });
      const dispatch = service.dispatch;
      service.dispatch = (...args) => {
        const operation = dispatch(...args);
        dispatchSettled = operation.catch((error: unknown) => {
          dispatchErrors.push(String(error));
        });
        return operation;
      };
      return service;
    },
  );
  const createService = workerEnvironmentService.createWorkerEnvironmentService;
  vi.spyOn(workerEnvironmentService, "createWorkerEnvironmentService").mockImplementation(
    (options) => {
      const service = createService(options);
      const { prepareProjectIntent, createWithRequest } = service;
      service.prepareProjectIntent = (...args) => {
        setupCalls.push("prepareProjectIntent");
        return prepareProjectIntent(...args);
      };
      service.createWithRequest = (...args) => {
        setupCalls.push("createWithRequest");
        return createWithRequest(...args);
      };
      return service;
    },
  );
  // Hold dispatch after its durable requested commit. The requested acknowledgment is reported
  // on resume, leaving the post-acknowledgment recheck as the only fence before setup I/O.
  let hold:
    | { committed: Deferred; resume: Promise<void>; afterAcknowledgment: boolean }
    | undefined;
  const createLifecycle = placementLifecycleStore.createPlacementLifecycleWorkerOps;
  vi.spyOn(placementLifecycleStore, "createPlacementLifecycleWorkerOps").mockImplementation(
    (options) => {
      const lifecycle = createLifecycle(options);
      const startDispatch = lifecycle.startDispatch.bind(lifecycle);
      lifecycle.startDispatch = async (...args) => {
        trace("lifecycle dispatch started");
        const placement = await startDispatch(...args);
        trace(`lifecycle dispatch returned ${placement.state}`);
        const current = hold;
        if (current && !current.afterAcknowledgment && placement.state === "requested") {
          hold = undefined;
          trace("pre-acknowledgment hold committed");
          current.committed.resolve();
          await current.resume;
          trace("pre-acknowledgment hold resumed");
        }
        return placement;
      };
      return lifecycle;
    },
  );
  // The requested acknowledgment and the failed dispatch's final transition each publish once.
  let settled: { remaining: number; done: Deferred } | undefined;
  const emitSessionsChanged = sessionChangeEvent.emitSessionsChanged;
  vi.spyOn(sessionChangeEvent, "emitSessionsChanged").mockImplementation((...args) => {
    if (args[1].reason === "dispatch") {
      trace(`dispatch event, remaining=${settled?.remaining}`);
    }
    if (args[1].reason === "dispatch" && settled && --settled.remaining === 0) {
      settled.done.resolve();
    }
    emitSessionsChanged(...args);
  });

  trace("gateway starting");
  await withGatewayServer(async ({ port }) => {
    trace("gateway ready");
    const connect = async (email: string, scopes: string[]) => {
      trace("websocket opening");
      const ws = await openWs(port, {
        origin,
        "x-forwarded-user": email,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
      });
      trace("websocket open; connect requested");
      const connected = await connectReq(ws, {
        prePairDevice: true,
        client: CONTROL_UI_CLIENT,
        browserOrigin: origin,
        skipDefaultAuth: true,
        scopes,
        deviceIdentityPath: path.join(temps.make("required-placement-"), "device.sqlite"),
      });
      trace(`connect replied ok=${connected.ok}`);
      expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
      return ws;
    };
    const adminWs = await connect(admin, ["operator.admin"]);
    const commitConfigPatch = async (patch: Record<string, unknown>) => {
      trace("config.get requested");
      const current = await rpcReq<{ hash: string }>(adminWs, "config.get", {});
      trace(`config.get replied ok=${current.ok}`);
      expect(current.ok, JSON.stringify(current.error)).toBe(true);
      trace("config.patch requested");
      const patched = await rpcReq(adminWs, "config.patch", {
        baseHash: current.payload?.hash,
        ...patch,
      });
      trace(`config.patch replied ok=${patched.ok}`);
      expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
    };
    const createThenEndAuthority = async (
      email: string,
      endAuthority: (ws: WebSocket) => Promise<void>,
      expectedSetupCalls: string[] = [],
      afterAcknowledgment = false,
    ) => {
      setupCalls.length = 0;
      const ws = await connect(email, ["operator.sessions.write"]);
      const committed = createDeferredCore();
      const resume = createDeferredCore();
      hold = { committed, resume: resume.promise, afterAcknowledgment };
      settled = { remaining: 2, done: createDeferredCore() };
      trace("sessions.create requested");
      const created = rpcReq(ws, "sessions.create", {});
      void created.then(
        (reply) => trace(`sessions.create replied ok=${reply.ok}`),
        () => trace("sessions.create rejected"),
      );
      try {
        if (afterAcknowledgment) {
          const acknowledged = await created;
          expect(acknowledged.ok, JSON.stringify(acknowledged.error)).toBe(true);
          await committed.promise;
        } else {
          await Promise.race([
            committed.promise,
            created.then(() => {
              throw new Error("sessions.create settled before its requested placement committed");
            }),
          ]);
        }
        trace("ending authority");
        await endAuthority(ws);
        trace("authority ended");
      } finally {
        resume.resolve();
      }
      trace("waiting for dispatch transitions");
      await settled.done.promise;
      trace("dispatch transitions settled");
      await dispatchSettled;
      trace("dispatch operation settled");
      expect(setupCalls, dispatchErrors.join("; ")).toEqual(expectedSetupCalls);
      return { ws, created };
    };
    try {
      // Let the RPC acknowledge and release its own custody before disconnecting.
      // Detached setup still owns the accepted source until its operation settles.
      scenario = "disconnect";
      const disconnected = await createThenEndAuthority(
        writers.disconnect,
        async (ws) => {
          const closed = createDeferredCore();
          ws.once("close", () => closed.resolve());
          ws.close();
          await closed.promise;
        },
        ["prepareProjectIntent", "createWithRequest"],
        true,
      );
      expect((await disconnected.created).ok).toBe(true);

      // A committed config patch removes the caller's operator scope.
      scenario = "scope";
      const revoked = await createThenEndAuthority(writers.scope, async () => {
        await commitConfigPatch({
          raw: JSON.stringify({ gateway: { auth: { identityScopes: { [writers.scope]: null } } } }),
          replacePaths: [`gateway.auth.identityScopes.${writers.scope}`],
        });
      });
      await expect(revoked.created).rejects.toThrow(/gateway policy changed/);

      // A committed config patch removes the required profile while the caller stays connected.
      scenario = "profile";
      const unprofiled = await createThenEndAuthority(writers.profile, async () => {
        await commitConfigPatch({
          raw: JSON.stringify({ cloudWorkers: { requiredProfile: null } }),
        });
      });
      await unprofiled.created;
      expect(unprofiled.ws.readyState).toBe(WebSocket.OPEN);
      unprofiled.ws.close();
    } finally {
      adminWs.close();
    }
  });
});
