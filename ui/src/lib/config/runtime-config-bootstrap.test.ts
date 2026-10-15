// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayHarness } from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("runtime config display bootstrap", () => {
  it("leaves editable config lazy while authenticated bootstrap preferences are pending", async () => {
    const request = vi.fn(async () => ({ config: {}, hash: "ready", valid: true, issues: [] }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    publish(false);
    let bootstrapConfig: Record<string, unknown> | null = null;
    const runtimeConfig = createRuntimeConfigCapability(gateway, {
      current: () => bootstrapConfig,
      subscribe: () => () => {},
    });
    publish(true);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    bootstrapConfig = { ui: { prefs: { themeMode: "dark" } } };
    expect(runtimeConfig.state.bootstrapConfig).toEqual(bootstrapConfig);
    await runtimeConfig.ensureLoaded();
    expect(request).toHaveBeenCalledExactlyOnceWith("config.get", {});
    runtimeConfig.dispose();
  });

  it.each([true, false])(
    "waits for authenticated display bootstrap before config fallback (available: %s)",
    async (available) => {
      const request = vi.fn(async () => ({ config: {}, hash: "ready", valid: true, issues: [] }));
      const client = { request } as unknown as GatewayBrowserClient;
      const { gateway } = createGatewayHarness(client);
      const ready = deferred();
      let bootstrapConfig: Record<string, unknown> | null = null;
      const runtimeConfig = createRuntimeConfigCapability(gateway, {
        current: () => bootstrapConfig,
        ready: () => ready.promise,
        subscribe: () => () => {},
      });
      const loading = runtimeConfig.ensureLoaded({ displayOnly: true });
      expect(request).not.toHaveBeenCalled();
      bootstrapConfig = available ? { ui: { prefs: {} } } : null;
      ready.resolve();
      await loading;
      expect(request).toHaveBeenCalledTimes(available ? 0 : 1);
      runtimeConfig.dispose();
    },
  );

  it.each(["replace", "dispose"] as const)(
    "does not let pending display bootstrap read after %s",
    async (operation) => {
      const request = vi.fn(async () => ({}));
      const client = { request } as unknown as GatewayBrowserClient;
      const { gateway, publish } = createGatewayHarness(client);
      const ready = deferred();
      const runtimeConfig = createRuntimeConfigCapability(gateway, {
        current: () => null,
        ready: () => ready.promise,
        subscribe: () => () => {},
      });
      const loading = runtimeConfig.ensureLoaded({ displayOnly: true });
      if (operation === "dispose") {
        runtimeConfig.dispose();
      } else {
        publish(false);
        publish(true);
      }
      ready.resolve();
      await loading;
      expect(request).not.toHaveBeenCalled();
      runtimeConfig.dispose();
    },
  );
});
