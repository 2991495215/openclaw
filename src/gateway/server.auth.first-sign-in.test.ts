import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookUserFirstSignInEvent } from "../plugins/hook-user-sign-in.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import {
  getTestPluginRegistry,
  resetTestPluginRegistry,
  setTestPluginRegistry,
} from "./test-helpers.plugin-registry.js";
import {
  resetUserFirstSignInDeliveriesForTests,
  settleUserFirstSignInDeliveriesForTests,
} from "./user-first-sign-in.js";

installGatewayTestHooks({ scope: "suite" });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const BROWSER_ORIGIN = "https://control.example.com";

afterEach(() => {
  resetTestPluginRegistry();
  resetUserFirstSignInDeliveriesForTests();
});

test("a trusted-proxy Control UI sign-in delivers user_first_sign_in once, after hello", async () => {
  const auth: GatewayAuthConfig = {
    mode: "trusted-proxy",
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      roles: {
        default: "guest",
        definitions: {
          guest: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
        },
      },
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });
  const events: PluginHookUserFirstSignInEvent[] = [];
  let releaseHandler!: () => void;
  const handlerGate = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "welcome" }));
  registry.typedHooks.push({
    pluginId: "welcome",
    hookName: "user_first_sign_in",
    source: "test",
    handler: async (event: PluginHookUserFirstSignInEvent) => {
      events.push(event);
      await handlerGate;
    },
  });
  setTestPluginRegistry(registry);
  initializeGlobalHookRunner(getTestPluginRegistry());
  const identityDir = tempDirs.make("openclaw-first-sign-in-");

  await withGatewayServer(async ({ port }) => {
    const signIn = async (attempt: number) => {
      const ws = await openWs(port, {
        origin: BROWSER_ORIGIN,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        "x-forwarded-user": "guest@example.com",
      });
      try {
        return await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes: ["operator.read"],
          client: { ...CONTROL_UI_CLIENT, instanceId: `first-sign-in-${attempt}` },
          deviceIdentityPath: path.join(
            identityDir,
            `guest-${attempt}`,
            "client",
            "credentials.sqlite",
          ),
          browserOrigin: BROWSER_ORIGIN,
        });
      } finally {
        ws.close();
      }
    };

    // The handler is still running, yet sign-in completed.
    expect((await signIn(1)).ok).toBe(true);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    releaseHandler();
    await settleUserFirstSignInDeliveriesForTests();
    expect((await signIn(2)).ok).toBe(true);
    await settleUserFirstSignInDeliveriesForTests();
  });

  expect(events).toEqual([
    expect.objectContaining({
      emails: ["guest@example.com"],
      githubAccountIds: [],
      isNewProfile: true,
      attempt: 1,
    }),
  ]);
});
