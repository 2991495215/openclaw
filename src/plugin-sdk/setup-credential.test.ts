import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { baseUrlTextInput, defineTokenCredential } from "./setup-credential.js";

type DemoAccount = {
  config: { token?: unknown; tokenFile?: string; baseUrl?: string };
  token?: string;
};

function resolveDemoAccount(cfg: OpenClawConfig): DemoAccount {
  const config = (cfg.channels?.demo ?? {}) as DemoAccount["config"];
  return { config, token: typeof config.token === "string" ? config.token : undefined };
}

function patchDemoConfig(params: {
  cfg: OpenClawConfig;
  patch: Record<string, unknown>;
  clearFields?: string[];
}): OpenClawConfig {
  const current = { ...((params.cfg.channels?.demo ?? {}) as Record<string, unknown>) };
  for (const field of params.clearFields ?? []) {
    delete current[field];
  }
  return {
    ...params.cfg,
    channels: { ...params.cfg.channels, demo: { ...current, ...params.patch } },
  } as OpenClawConfig;
}

describe("defineTokenCredential", () => {
  afterEach(() => vi.unstubAllEnvs());
  const definition = defineTokenCredential({
    inputKey: "token",
    configKey: "token",
    configuredFields: ["token", "tokenFile"],
    providerHint: "demo",
    credentialLabel: "token",
    envPrompt: "env",
    keepPrompt: "keep",
    inputPrompt: "input",
    resolveAccount: ({ cfg }) => resolveDemoAccount(cfg),
    resolvedValue: (account) => account.token,
    envValue: () => "env-token",
    patchAccount: ({ cfg, patch, clearFields }) => patchDemoConfig({ cfg, patch, clearFields }),
    useEnv: { clearFields: ["token", "tokenFile"] },
    set: { clearFields: ["tokenFile"], value: "resolved" },
  });

  it("inspects configured fields and resolved/env values", () => {
    expect(
      definition.inspect({
        cfg: { channels: { demo: { tokenFile: "/tmp/token" } } } as OpenClawConfig,
        accountId: "default",
      }),
    ).toEqual({
      accountConfigured: true,
      hasConfiguredValue: true,
      resolvedValue: undefined,
      envValue: "env-token",
    });
  });

  it("clears sibling fields for env and set writes", async () => {
    const cfg = {
      channels: { demo: { token: "old", tokenFile: "/tmp/token", baseUrl: "https://demo" } },
    } as OpenClawConfig;
    const envConfig = await definition.applyUseEnv?.({ cfg, accountId: "default" });
    expect(envConfig?.channels?.demo).toEqual({ baseUrl: "https://demo" });

    const setConfig = await definition.applySet?.({
      cfg,
      accountId: "default",
      credentialValues: {},
      value: "raw",
      resolvedValue: "redacted",
    });
    expect(setConfig?.channels?.demo).toEqual({ token: "redacted", baseUrl: "https://demo" });
  });

  it("offers the declared environment credential only for the default account", () => {
    vi.stubEnv("OPENCLAW_TEST_SETUP_TOKEN", "  env-token  ");
    const credential = defineTokenCredential({
      inputKey: "token",
      defaultAccountEnv: "OPENCLAW_TEST_SETUP_TOKEN",
      providerHint: "demo",
      credentialLabel: "token",
      envPrompt: "env",
      keepPrompt: "keep",
      inputPrompt: "input",
      resolveAccount: ({ cfg }) => resolveDemoAccount(cfg),
    });
    const cfg = {};
    expect(credential.preferredEnvVar).toBe("OPENCLAW_TEST_SETUP_TOKEN");
    expect(credential.allowEnv?.({ cfg, accountId: "default" })).toBe(true);
    expect(credential.inspect({ cfg, accountId: "default" }).envValue).toBe("env-token");
    expect(credential.allowEnv?.({ cfg, accountId: "work" })).toBe(false);
    expect(credential.inspect({ cfg, accountId: "work" }).envValue).toBeUndefined();

    vi.stubEnv("OPENCLAW_TEST_SETUP_TOKEN", "  ");
    expect(credential.inspect({ cfg, accountId: "default" }).envValue).toBeUndefined();
    expect(
      credential.inspect({
        cfg: { channels: { demo: { token: "configured" } } } as OpenClawConfig,
        accountId: "default",
      }).hasConfiguredValue,
    ).toBe(true);
  });
});

describe("baseUrlTextInput", () => {
  it("wires current, normalize, validate, and patch behavior", async () => {
    const input = baseUrlTextInput({
      inputKey: "httpUrl",
      configKey: "baseUrl",
      message: "URL",
      resolveAccount: ({ cfg }) => resolveDemoAccount(cfg),
      currentValue: (account) => account.config.baseUrl,
      includeInitialValue: true,
      validate: (value) => (value.startsWith("https://") ? undefined : "https required"),
      normalize: (value) => value.trim().replace(/\/$/, ""),
      patchAccount: ({ cfg, patch }) => patchDemoConfig({ cfg, patch }),
    });
    const cfg = { channels: { demo: { baseUrl: "https://old" } } } as OpenClawConfig;
    expect(await input.currentValue?.({ cfg, accountId: "default", credentialValues: {} })).toBe(
      "https://old",
    );
    expect(
      input.validate?.({ value: "http://bad", cfg, accountId: "default", credentialValues: {} }),
    ).toBe("https required");
    expect(
      input.normalizeValue?.({
        value: " https://new/ ",
        cfg,
        accountId: "default",
        credentialValues: {},
      }),
    ).toBe("https://new");
    expect(await input.applySet?.({ cfg, accountId: "default", value: "https://new" })).toEqual({
      channels: { demo: { baseUrl: "https://new" } },
    });
  });
});
