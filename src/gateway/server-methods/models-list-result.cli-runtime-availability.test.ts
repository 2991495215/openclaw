import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import {
  createModelCatalogDecisions,
  prepareModelCatalogDecisions,
} from "../../agents/model-catalog-decisions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadDeferredCatalog } from "../server-model-catalog-auth.js";
import { buildModelsListResult } from "./models-list-result.js";
import {
  createModelsListTestContext,
  listModels,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

const config = {
  agents: {
    defaults: { model: { primary: "anthropic/claude-opus-5" } },
    entries: {
      main: {
        models: {
          "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
        },
      },
    },
  },
} satisfies OpenClawConfig;

async function listClaudeCliModel(
  params: {
    authenticated?: boolean;
    providerApiKey?: boolean;
    pluginDisabled?: boolean;
    cfg?: OpenClawConfig;
  } = {},
) {
  return await listModels({
    catalog: [],
    staticEntries: [providerCatalogEntry("anthropic", "claude-opus-5")],
    cfg:
      params.cfg ??
      (params.pluginDisabled
        ? { ...config, plugins: { entries: { anthropic: { enabled: false } } } }
        : config),
    preparedAuthModes: params.authenticated ? { "claude-cli": "api_key" } : {},
    catalogComplete: true,
    view: "configured",
    includeDefaultModels: false,
  });
}

describe("models.list CLI runtime availability", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    // Prepared runtime metadata must not cold-load the plugin's executable setup entry.
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    vi.unstubAllEnvs();
  });

  it.each([
    {
      authenticated: true,
      providerApiKey: false,
      pluginDisabled: false,
      available: true,
      reason: undefined,
    },
    {
      authenticated: false,
      providerApiKey: true,
      pluginDisabled: false,
      available: false,
      reason: "missing-auth",
    },
    {
      authenticated: true,
      providerApiKey: false,
      pluginDisabled: true,
      available: false,
      reason: "missing-auth",
    },
  ])(
    "reports native login=$authenticated, provider key=$providerApiKey, and plugin disabled=$pluginDisabled",
    async (scenario) => {
      vi.stubEnv("ANTHROPIC_API_KEY", scenario.providerApiKey ? "test-key" : "");
      const result = await listClaudeCliModel(scenario);
      expect(result).toEqual({
        models: [expect.objectContaining({ id: "claude-opus-5", available: scenario.available })],
      });
      expect(result.models[0]?.unavailableReason).toBe(scenario.reason);
      expect(result.models[0]?.unavailableUntil).toBeUndefined();
    },
  );

  it("keeps every Claude CLI model listed as needing login before the full catalog arrives", async () => {
    const pinned = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"];
    const result = await listModels({
      catalog: [...pinned, "claude-haiku-4-5"].map((id) => providerCatalogEntry("anthropic", id)),
      cfg: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-5" },
            models: Object.fromEntries(
              pinned.map((id) => [`anthropic/${id}`, { agentRuntime: { id: "claude-cli" } }]),
            ),
          },
        },
      },
      view: "configured",
      includeDefaultModels: false,
    });
    expect(
      result.models
        .map(({ id, available, unavailableReason }) => ({ id, available, unavailableReason }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(pinned.map((id) => ({ id, available: false, unavailableReason: "missing-auth" })));
  });

it.each<{
  name: string;
  available: boolean;
  oauth?: boolean;
  order?: Record<string, string[]>;
  disabled?: boolean;
}>([
  { name: "saved setup tokens", available: true },
  { name: "saved OAuth subscription", oauth: true, available: true },
  { name: "empty CLI account order", order: { "claude-cli": [] }, available: false },
  { name: "empty provider account order", order: { anthropic: [] }, available: false },
  { name: "API-key-only account order", order: { anthropic: ["api"] }, available: false },
  { name: "disabled plugin", disabled: true, available: false },
])("evaluates unpinned Claude CLI models with $name and no native login", async (testCase) => {
  const result = await listModels({
    cfg: {
      ...config,
      auth: { order: testCase.order },
      ...(testCase.disabled ? { plugins: { entries: { anthropic: { enabled: false } } } } : {}),
    },
    catalog: [providerCatalogEntry("anthropic", "claude-opus-5")],
    preparedAuthModes: {},
    preparedAuthStore: {
      version: 1,
      profiles: {
        first: testCase.oauth ? oauthCredential("anthropic") : token("anthropic"),
        second: token("anthropic", testCase.oauth),
        api: { type: "api_key", provider: "anthropic", key: "synthetic-api-key" },
      },
    },
    view: "configured",
    includeDefaultModels: false,
  });
  expect(result.models).toEqual([
    expect.objectContaining({
      id: "claude-opus-5",
      available: testCase.available,
      agentRuntime: expect.objectContaining({ id: "claude-cli" }),
    }),
  ]);
  expect(result.models[0]?.unavailableReason).toBe(testCase.available ? undefined : "missing-auth");
});

it.each([
  { selection: "default", expired: false, sharedOrder: false },
  { selection: "draft", expired: false, sharedOrder: true },
  { selection: "draft", expired: true, sharedOrder: true },
  { selection: "default", expired: true, sharedOrder: true },
  { selection: "default", expired: true, sharedOrder: true, oauth: true },
])(
  "uses personal $selection auth instead of native login (expired=$expired, sharedOrder=$sharedOrder, oauth=$oauth)",
  async ({ selection, expired, sharedOrder, oauth }) => {
    return withOpenClawTestState(
      { layout: "state-only", prefix: "personal-cli-model-catalog-" },
      async (state) => {
        const owner = ensureProfileForEmail("alice@example.test");
        const { authProfileId } = connectUserModelAccount({
          ownerProfileId: owner.id,
          credential: oauth
            ? oauthCredential("anthropic", true)
            : token("anthropic", expired, "synthetic-personal-token"),
          assertCurrent() {},
        });
        if (selection === "draft") {
          clearUserProfileAuthLink({ profileId: owner.id, provider: "anthropic" });
        }
        const cfg: OpenClawConfig = {
          ...config,
          agents: { ...config.agents, defaults: { model: `${opus}@anthropic:missing` } },
          ...(sharedOrder ? { auth: { order: { anthropic: ["anthropic:shared"] } } } : {}),
        };
        if (sharedOrder) {
          await state.writeAuthProfiles({
            version: 1,
            profiles: { "anthropic:shared": token("anthropic", !expired) },
          });
          if (selection === "draft") {
            clearUserProfileAuthLink({ profileId: owner.id, provider: "anthropic" });
          }
          const cfg: OpenClawConfig = sharedOrder
            ? { ...config, auth: { order: { anthropic: ["anthropic:shared"] } } }
            : config;
          if (sharedOrder) {
            await state.writeAuthProfiles({
              version: 1,
              profiles: {
                "anthropic:shared": {
                  type: "token",
                  provider: "anthropic",
                  token: "synthetic-shared-token",
                  expires: Date.now() + (expired ? 600_000 : -60_000),
                },
              },
            });
          }
          const context = createModelsListTestContext({
            cfg,
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            catalog: [providerCatalogEntry("anthropic", "claude-opus-5")],
            catalogComplete: true,
            preparedAuthModes: expired ? { "claude-cli": "oauth" } : {},
          });
          const snapshot = await loadDeferredCatalog(context, "main", { readOnly: true });
          const result = await buildModelsListResult({
            source: { kind: "gateway", context },
            agentId: "main",
            requesterProfileId: owner.id,
            params: { view: "configured", preparedOnly: true },
            preloadedCatalog: { agentId: "main", config: cfg, snapshot },
            preloadedOnly: true,
            catalogProjector: await prepareModelCatalogDecisions({
              cfg,
              agentId: "main",
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              snapshot,
              metadataSnapshot: snapshot.metadataSnapshot,
              preparedAuthStore: snapshot.authStore,
              preparedRuntimeAuthModes: snapshot.authModes,
              preparedSyntheticAuthComplete: snapshot.catalogComplete,
              requesterProfileId: owner.id,
              ...(selection === "draft"
                ? { preferredProfileId: authProfileId, pinnedProfileId: authProfileId }
                : {}),
            }),
          });

          const model = result.models.find(
            (entry) => entry.provider === "anthropic" && entry.id === "claude-opus-5",
          );
          expect(model).toMatchObject({
            agentRuntime: expect.objectContaining({ id: "claude-cli" }),
            available: !expired,
          });
          expect(model?.unavailableReason).toBe(expired && !oauth ? "auth-failed" : undefined);
        },
      );
    },
  );

  it.each([
    { scenario: "direct ready", available: true },
    {
      scenario: "direct unavailable",
      expired: true,
      unrefreshable: true,
      available: false,
      reason: "auth-failed",
    },
    { scenario: "direct refresh-needed", expired: true, available: false },
    {
      scenario: "canonical pin",
      provider: "anthropic",
      pinProvider: "anthropic",
      expired: true,
      available: true,
    },
    {
      scenario: "CLI pin",
      provider: "anthropic",
      sharedProvider: "anthropic",
      expired: true,
      available: false,
    },
  ])("uses the selected execution owner for $scenario", async (scenario) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cli-pin-identity-" },
      async (state) => {
        const provider = scenario.provider ?? "claude-cli";
        const pinProvider = scenario.pinProvider ?? "claude-cli";
        const sharedProvider = scenario.sharedProvider ?? "claude-cli";
        const modelId = "claude-haiku-4-5";
        const cfg: OpenClawConfig = {
          agents: {
            defaults: { model: { primary: `${provider}/${modelId}` } },
            entries: { main: {} },
          },
          auth: {
            profiles: {
              selected: { provider: pinProvider, mode: "oauth" },
              shared: { provider: sharedProvider, mode: "token" },
            },
            order: { [provider]: ["shared"] },
          },
        };
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            selected: {
              type: "oauth",
              provider: pinProvider,
              access: "synthetic-access",
              refresh: scenario.unrefreshable ? "" : "synthetic-refresh",
              expires: scenario.expired ? 1 : Date.now() + 600_000,
            },
            shared: {
              type: "token",
              provider: sharedProvider,
              token: "synthetic-shared",
              expires: Date.now() + 600_000,
            },
          },
        });
        const context = createModelsListTestContext({
          cfg,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          catalog: [providerCatalogEntry(provider, modelId)],
          catalogComplete: true,
          preparedAuthModes: { "claude-cli": "oauth" },
        });
        const snapshot = await loadDeferredCatalog(context, "main", { readOnly: true });
        const result = await buildModelsListResult({
          source: { kind: "gateway", context },
          agentId: "main",
          params: { view: "all", preparedOnly: true },
          preloadedCatalog: { agentId: "main", config: cfg, snapshot },
          preloadedOnly: true,
          catalogProjector: createModelCatalogDecisions({
            cfg,
            agentId: "main",
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            snapshot,
            metadataSnapshot: snapshot.metadataSnapshot,
            preparedAuthStore: snapshot.authStore,
            preparedRuntimeAuthModes: snapshot.authModes,
            preparedSyntheticAuthComplete: true,
            preferredProfileId: "selected",
            pinnedProfileId: "selected",
          }),
        });
        const model = result.models.find(
          (entry) => entry.provider === provider && entry.id === modelId,
        );
        expect(model).toMatchObject({ available: scenario.available });
        expect(model?.unavailableReason).toBe(scenario.reason);
      },
    );
  },
);

const cli = "claude-cli",
  api = "anthropic";
it.each([
  ["direct ready", cli, cli, cli, false, false, true, undefined],
  ["direct unavailable", cli, cli, cli, true, true, false, "auth-failed"],
  ["direct refresh-needed", cli, cli, cli, true, false, false, undefined],
  ["canonical pin", api, api, cli, true, false, true, undefined],
  ["CLI pin", api, cli, api, true, false, false, undefined],
] as const)(
  "uses the selected execution owner for %s",
  async (_name, provider, pinProvider, sharedProvider, expired, noRefresh, available, reason) =>
    withOpenClawTestState({ layout: "state-only", prefix: "cli-pin-identity-" }, async (state) => {
      const modelId = "claude-haiku-4-5";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: { primary: `${provider}/${modelId}` } },
          entries: { main: {} },
        },
        auth: {
          profiles: {
            selected: { provider: pinProvider, mode: "oauth" },
            shared: { provider: sharedProvider, mode: "token" },
          },
          order: { [provider]: ["shared"] },
        },
      };
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          selected: oauthCredential(pinProvider, expired, noRefresh),
          shared: token(sharedProvider),
        },
      });
      const model = await listPrepared(cfg, state, provider, modelId, true, {
        preferredProfileId: "selected",
        pinnedProfileId: "selected",
      });
      expect([model?.available, model?.unavailableReason]).toEqual([available, reason]);
    }),
);

it.each([
  { name: "inherited default", available: true },
  { name: "agent primary", agentPrimary: true, available: true },
  { name: "aliased primary", alias: true, available: true },
  { name: "expired configured pin", expired: true, available: false },
  { name: "missing configured pin", missing: true, nativeLogin: true, available: false },
  { name: "explicit session pin", explicit: true, available: false },
  { name: "automatic session preference", automatic: true, available: true },
  { name: "unrelated sibling", sibling: true, available: true },
  { name: "overridden default", unpinned: true, available: true },
])("evaluates the effective configured primary account: $name", async (testCase) => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "configured-cli-pin-" },
    async (state) => {
      const profileId = "anthropic:configured";
      const raw = `${testCase.alias ? "primary-alias" : opus}@${profileId}`;
      const cfg: OpenClawConfig = {
        // A pin bypasses automatic account order; unpinned rows retain saved-subscription selection.
        auth: { order: testCase.sibling || testCase.unpinned ? undefined : { anthropic: [] } },
        agents: {
          defaults: { model: { primary: raw } },
          entries: {
            main: {
              ...(testCase.agentPrimary ? { model: raw } : {}),
              ...(testCase.unpinned ? { model: opus } : {}),
              models: {
                [opus]: { alias: "primary-alias", agentRuntime: { id: "claude-cli" } },
                "anthropic/claude-haiku-4-5": { agentRuntime: { id: "claude-cli" } },
              },
            },
          },
        },
      };
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          ...(testCase.missing ? {} : { [profileId]: token("anthropic", testCase.expired) }),
          "anthropic:session": token("anthropic", true),
        },
      });
      const modelId = testCase.sibling ? "claude-haiku-4-5" : "claude-opus-5";
      const model = await listPrepared(
        cfg,
        state,
        "anthropic",
        modelId,
        Boolean(testCase.expired || testCase.nativeLogin),
        {
          ...(testCase.explicit || testCase.automatic
            ? { preferredProfileId: "anthropic:session" }
            : {}),
          ...(testCase.explicit ? { pinnedProfileId: "anthropic:session" } : {}),
        },
      );
      expect(model?.available).toBe(testCase.available);
      if (testCase.available) {
        expect(model?.unavailableReason).toBeUndefined();
      }
    },
  );
});
