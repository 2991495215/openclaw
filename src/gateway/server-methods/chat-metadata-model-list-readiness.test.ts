import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import * as catalogRuntime from "../../agents/prepared-model-catalog.js";
import { bindPreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { registerGatewayModelCatalogPrivateAccess } from "../server-model-catalog-auth.js";
import { readPreparedGatewayModelCatalogOwnerSnapshot } from "../server-model-catalog.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import {
  chatMetadataCommandFields,
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";
import * as modelLists from "./models-list-result.js";
import {
  createModelsListTestContext,
  requestModelsList,
} from "./models-list-result.openai-routes.test-support.js";
import type { RespondFn } from "./types.js";

it("serves a new model-list view from a healthy owner during a sibling replacement", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = {
      agents: {
        entries: { main: {} },
        defaults: { model: "test/first", modelPolicy: { allow: ["test/*"] } },
      },
    };
    const harness = createChatMetadataHarness(config);
    const owner = {
      ...createChatMetadataOwner(config, "first", {}, "test", "openai-completions"),
      pluginRegistry: createEmptyPluginRegistry(),
    };
    harness.setOwner(owner);
    const context = createModelsListTestContext({
      cfg: config,
      catalog: owner.modelCatalog.entries,
      pluginRegistry: owner.pluginRegistry,
      preparedAuthStore: { version: 1, profiles: {} },
    });
    context.readPreparedModelsList = harness.runtime.readModelsList;
    const readPrepared = () =>
      readPreparedGatewayModelCatalogOwnerSnapshot({ agentId: "main", getConfig: () => config });
    registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
      readPrepared,
      loadDeferred: async () => {
        throw new Error("Reading a published owner must not activate catalog discovery");
      },
    });
    const read = async (view: "configured" | "all") => {
      const response = await requestModelsList(context, { agentId: "main", view });
      expect(response.mock.calls[0]?.[0]).toBe(true);
      expect(response.mock.calls[0]?.[1]).toMatchObject({
        models: [expect.objectContaining({ id: "first" })],
      });
      return response.mock.calls[0]?.[1];
    };
    const replacement = createDeferredCore();
    try {
      await harness.runtime.refresh();
      const cached = await read("configured");
      using pending = vi
        .spyOn(catalogRuntime, "getPendingPreparedModelRuntimeReplacement")
        .mockReturnValue(replacement.promise);
      harness.runtime.invalidate();
      const currentAuth: AuthProfileStore = {
        version: 1,
        profiles: { "test:current": { type: "api_key", provider: "test", key: "synthetic" } },
        order: { test: ["test:current"] },
      };
      harness.setAuthStore(currentAuth);
      const materializations = [
        {
          provider: "test",
          modelId: "first",
          modelApi: "openai-completions",
          modelBaseUrl: "https://example.test/v1",
          requestTransportOverrides: "none" as const,
          authMode: "api_key",
          runtimeOwnerId: "openclaw",
        },
      ];
      bindPreparedModelRuntimeAuth(owner, {
        store: { version: 1, profiles: {} },
        materializations,
      });
      const published = await withinTest(readPrepared(), signal);
      expect(published?.authStore).toBe(currentAuth);
      expect(published?.authMaterializations).toBe(materializations);
      expect(pending).not.toHaveBeenCalled();
      await withinTest(read("all"), signal);
      expect(await read("configured")).toEqual(cached);
    } finally {
      replacement.resolve();
      await harness.runtime.stop();
    }
  });
});

it("waits for a missing catalog owner and rereads its config after publication", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    let config: OpenClawConfig = { agents: { entries: { main: {} } } };
    const harness = createChatMetadataHarness(config);
    harness.getPreparedOwner.mockReturnValue(undefined);
    const replacement = createDeferredCore();
    const entered = createDeferredCore();
    using pending = vi
      .spyOn(catalogRuntime, "getPendingPreparedModelRuntimeReplacement")
      .mockImplementation(() => {
        entered.resolve();
        return replacement.promise;
      });
    const getConfig = vi.fn(() => config);
    const reading = readPreparedGatewayModelCatalogOwnerSnapshot({ agentId: "main", getConfig });
    let settled = false;
    void reading.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await withinTest(entered.promise, signal);
      expect(settled).toBe(false);
      config = { agents: { entries: { main: { workspace: "/tmp/published-workspace" } } } };
      const owner = createChatMetadataOwner(config, "published");
      harness.getPreparedOwner.mockReturnValue(owner);
      replacement.resolve();
      await expect(withinTest(reading, signal)).resolves.toMatchObject({
        config,
        entries: [{ id: "published" }],
      });
      expect(getConfig).toHaveBeenCalledTimes(2);
      harness.getPreparedOwner.mockReturnValue(undefined);
      pending.mockReturnValue(undefined);
      await expect(
        readPreparedGatewayModelCatalogOwnerSnapshot({ getConfig }),
      ).resolves.toBeUndefined();
    } finally {
      replacement.resolve();
      await Promise.allSettled([reading]);
      await harness.runtime.stop();
    }
  });
});

it("serves commands independently of another agent's remembered model list", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = {
      agents: {
        entries: { main: {}, other: {} },
        defaults: { model: "test/main-model", modelPolicy: { allow: ["test/*"] } },
      },
    };
    const pluginRegistry = createEmptyPluginRegistry();
    const owner = (id: string) => ({
      ...createChatMetadataOwner(config, id, {}, "test", "openai-completions"),
      pluginRegistry,
    });
    const mainOwner = owner("main-model");
    let otherOwner = owner("other-model");
    const harness = createChatMetadataHarness(config);
    harness.setOwner(mainOwner);
    harness.getPreparedOwner.mockImplementation((params) =>
      params?.agentId === "other" ? otherOwner : mainOwner,
    );
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      readChatMetadata: harness.runtime.read,
    });
    const readCommands = async () => {
      const respond = vi.fn<RespondFn>();
      await handleChatMetadataRequest({
        req: { type: "req", id: "commands-readiness", method: "chat.metadata" },
        params: { agentId: "main", includeModels: false },
        context,
        client: null,
        respond,
        signal,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(true, {
        commands: [{ ...chatMetadataCommandFields, name: "command-1-1" }],
        swarmEnabled: true,
        revision: expect.any(String),
      });
    };
    const request = {
      agentId: "other",
      params: { agentId: "other", view: "all" as const },
      includeManualSelection: true,
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const abort = () => release.resolve();
    signal.addEventListener("abort", abort, { once: true });
    let blockOther = false;
    const prepare = modelLists.prepareModelsListResult;
    const preparation = vi
      .spyOn(modelLists, "prepareModelsListResult")
      .mockImplementation(async (params) => {
        if (blockOther && params.agentId === "other") {
          entered.resolve();
          await release.promise;
        }
        return prepare(params);
      });
    const pending: Promise<unknown>[] = [];
    try {
      await harness.runtime.refresh();
      await expect(harness.runtime.readModelsList(request)).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "other-model" })]),
      });
      await readCommands();
      otherOwner = owner("replacement-model");
      blockOther = true;
      // Reads during a refresh get the retained list; hold the replacement's own preparation.
      await harness.runtime.refresh();
      const models = harness.runtime.readModelsList(request);
      pending.push(models);
      await withinTest(entered.promise, signal);
      console.info("chat-metadata-readiness", { phase: "other model list held" });
      const started = performance.now();
      const reading = readCommands();
      pending.push(reading);
      await withinTest(reading, signal);
      console.info("chat-metadata-readiness", {
        phase: "commands completed while other model list held",
        elapsedMs: performance.now() - started,
      });
      release.resolve();
      await Promise.all(pending);
      await expect(harness.runtime.readModelsList(request)).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "replacement-model" })]),
      });
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      preparation.mockRestore();
      signal.removeEventListener("abort", abort);
      await harness.runtime.stop();
    }
  });
});
