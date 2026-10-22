import { omitUndefinedFields } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { AgentHarness, AgentHarnessRegistrationOptions } from "../agents/harness/types.js";
import { warnOnMissingCliBackendModelProvider } from "./cli-backend-registration.js";
import { getCoreEmbeddingProvider } from "./core-embedding-providers.js";
import type { EmbeddingProviderAdapter } from "./embedding-providers.js";
import {
  isPluginManifestOnboardingScope,
  normalizeProviderAssistantVisibility,
  optionalManifestFields,
} from "./manifest-capability-normalizers.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { getPluginInstance, getPluginValueInstance } from "./plugin-instance-scope.js";
import { invalidateProviderRegistryIndex } from "./provider-registry-index.js";
import { canClaimReservedCommandOwnership } from "./registry-registrars-operations.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginOwnedProviderRegistration, PluginRecord } from "./registry-types.js";
import { validateStorageProviderContract } from "./storage-provider-registry.js";
import type { CliBackendPlugin, ProviderAuthMethod, ProviderPlugin } from "./types.js";
import { validateWorkerProviderContract } from "./worker-provider-registry.js";

type ProviderWizardSetup = NonNullable<NonNullable<ProviderPlugin["wizard"]>["setup"]>;
type ProviderWizardModelPicker = NonNullable<NonNullable<ProviderPlugin["wizard"]>["modelPicker"]>;
type ProviderWizardModelAllowlist = NonNullable<ProviderWizardSetup["modelAllowlist"]>;

function normalizeTextList(values: string[] | undefined): string[] | undefined {
  const normalized = normalizeUniqueTrimmedStringList(values);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOnboardingScopes(
  values: Array<"text-inference" | "image-generation" | "music-generation"> | undefined,
): Array<"text-inference" | "image-generation" | "music-generation"> | undefined {
  const normalized = Array.from(new Set((values ?? []).filter(isPluginManifestOnboardingScope)));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProviderOAuthProfileIdRepairs(
  values: ProviderPlugin["oauthProfileIdRepairs"],
): ProviderPlugin["oauthProfileIdRepairs"] {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized = values
    .map((value) => {
      const legacyProfileId = normalizeOptionalString(value?.legacyProfileId);
      const promptLabel = normalizeOptionalString(value?.promptLabel);
      if (!legacyProfileId && !promptLabel) {
        return null;
      }
      return {
        ...(legacyProfileId ? { legacyProfileId } : {}),
        ...(promptLabel ? { promptLabel } : {}),
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
  return normalized.length > 0 ? normalized : undefined;
}

function buildNormalizedModelAllowlist(
  modelAllowlist: ProviderWizardModelAllowlist | undefined,
): ProviderWizardModelAllowlist | undefined {
  if (!modelAllowlist) {
    return undefined;
  }
  return optionalManifestFields({
    allowedKeys: normalizeTextList(modelAllowlist.allowedKeys),
    initialSelections: normalizeTextList(modelAllowlist.initialSelections),
    loadCatalog: modelAllowlist.loadCatalog === true ? true : undefined,
    message: normalizeOptionalString(modelAllowlist.message),
  });
}

function buildNormalizedWizardSetup(
  setup: ProviderWizardSetup,
  methodId: string | undefined,
): ProviderWizardSetup {
  return omitUndefinedFields({
    choiceId: normalizeOptionalString(setup.choiceId),
    modelTarget: setup.modelTarget === "utility" ? ("utility" as const) : undefined,
    choiceLabel: normalizeOptionalString(setup.choiceLabel),
    choiceHint: normalizeOptionalString(setup.choiceHint),
    assistantPriority:
      typeof setup.assistantPriority === "number" && Number.isFinite(setup.assistantPriority)
        ? setup.assistantPriority
        : undefined,
    assistantVisibility: normalizeProviderAssistantVisibility(setup.assistantVisibility),
    onboardingFeatured: setup.onboardingFeatured === true ? true : undefined,
    groupId: normalizeOptionalString(setup.groupId),
    groupLabel: normalizeOptionalString(setup.groupLabel),
    groupHint: normalizeOptionalString(setup.groupHint),
    methodId,
    onboardingScopes: normalizeOnboardingScopes(setup.onboardingScopes),
    modelAllowlist: buildNormalizedModelAllowlist(setup.modelAllowlist),
    modelSelection: optionalManifestFields({
      promptWhenAuthChoiceProvided:
        typeof setup.modelSelection?.promptWhenAuthChoiceProvided === "boolean"
          ? setup.modelSelection.promptWhenAuthChoiceProvided
          : undefined,
      allowKeepCurrent:
        typeof setup.modelSelection?.allowKeepCurrent === "boolean"
          ? setup.modelSelection.allowKeepCurrent
          : undefined,
    }),
  });
}

function buildNormalizedModelPicker(
  modelPicker: ProviderWizardModelPicker,
  methodId: string | undefined,
): ProviderWizardModelPicker {
  return omitUndefinedFields({
    label: normalizeOptionalString(modelPicker.label),
    hint: normalizeOptionalString(modelPicker.hint),
    methodId,
  });
}

export function createProviderRegistrars(state: PluginRegistryState) {
  const {
    registry,
    createIdentityRegistration,
    createRegistration,
    pushDiagnostic,
    reportRegistrationError,
    reportRegistrationWarning,
    registerModelCatalogProvider,
  } = state;

  const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
    /** Normalizes provider plugin metadata and emits diagnostics for invalid public fields. */
    function normalizeProvider(): ProviderPlugin | null {
      const diagnose = (level: PluginDiagnostic["level"], message: string) =>
        pushDiagnostic({ level, pluginId: record.id, source: record.source, message });
      const id = normalizeOptionalString(provider.id);
      if (!id) {
        diagnose("error", "provider registration missing id");
        return null;
      }
      if (
        provider.authScope !== undefined &&
        provider.authScope !== "agent" &&
        provider.authScope !== "plugin"
      ) {
        diagnose("error", `provider "${id}" authScope must be agent or plugin`);
        return null;
      }
      function normalizeWizardSurface<T extends { methodId?: string }>(
        surface: T | undefined,
        metadataKind: "setup" | "model-picker",
        project: (surface: T, methodId: string | undefined) => T,
        methodIds: ReadonlySet<string>,
      ): T | undefined {
        if (!surface) {
          return undefined;
        }
        if (methodIds.size === 0) {
          diagnose(
            "warn",
            `provider "${id}" ${metadataKind} metadata ignored because it has no auth methods`,
          );
          return undefined;
        }
        let methodId = normalizeOptionalString(surface.methodId);
        if (methodId && !methodIds.has(methodId)) {
          diagnose(
            "warn",
            `provider "${id}" ${metadataKind} method "${methodId}" not found; falling back to available methods`,
          );
          methodId = undefined;
        }
        return project(surface, methodId);
      }

      const seenMethodIds = new Set<string>();
      const auth: ProviderAuthMethod[] = [];
      for (const method of provider.auth ?? []) {
        const methodId = normalizeOptionalString(method.id);
        if (!methodId) {
          diagnose("error", `provider "${id}" auth method missing id`);
          continue;
        }
        if (seenMethodIds.has(methodId)) {
          diagnose("error", `provider "${id}" auth method duplicated id "${methodId}"`);
          continue;
        }
        seenMethodIds.add(methodId);
        const wizard = normalizeWizardSurface(
          method.wizard,
          "setup",
          buildNormalizedWizardSetup,
          new Set([methodId]),
        );
        const hint = normalizeOptionalString(method.hint);
        auth.push({
          ...method,
          id: methodId,
          label: normalizeOptionalString(method.label) ?? methodId,
          ...(hint ? { hint } : {}),
          ...(wizard ? { wizard } : {}),
        });
      }
      const docsPath = normalizeOptionalString(provider.docsPath);
      const aliases = normalizeTextList(provider.aliases);
      const deprecatedProfileIds = normalizeTextList(provider.deprecatedProfileIds);
      const oauthProfileIdRepairs = normalizeProviderOAuthProfileIdRepairs(
        provider.oauthProfileIdRepairs,
      );
      const envVars = normalizeTextList(provider.envVars);
      const setup = normalizeWizardSurface(
        provider.wizard?.setup,
        "setup",
        buildNormalizedWizardSetup,
        seenMethodIds,
      );
      const modelPicker = normalizeWizardSurface(
        provider.wizard?.modelPicker,
        "model-picker",
        buildNormalizedModelPicker,
        seenMethodIds,
      );
      const catalog = provider.catalog;
      const {
        wizard: _ignoredWizard,
        docsPath: _ignoredDocsPath,
        aliases: _ignoredAliases,
        envVars: _ignoredEnvVars,
        catalog: _ignoredCatalog,
        ...restProvider
      } = provider;
      return {
        ...restProvider,
        id,
        label: normalizeOptionalString(provider.label) ?? id,
        ...(docsPath ? { docsPath } : {}),
        ...(aliases ? { aliases } : {}),
        ...(deprecatedProfileIds ? { deprecatedProfileIds } : {}),
        ...(oauthProfileIdRepairs ? { oauthProfileIdRepairs } : {}),
        ...(envVars ? { envVars } : {}),
        auth,
        ...(catalog ? { catalog } : {}),
        ...(setup || modelPicker
          ? { wizard: { ...(setup ? { setup } : {}), ...(modelPicker ? { modelPicker } : {}) } }
          : {}),
      };
    }
    const normalizedProvider = normalizeProvider();
    if (!normalizedProvider) {
      return;
    }
    const id = normalizedProvider.id;
    const existing = registry.providers.find((entry) => entry.provider.id === id);
    if (existing) {
      reportRegistrationError(record, `provider already registered: ${id} (${existing.pluginId})`);
      return;
    }
    if (!record.providerIds.includes(id)) {
      record.providerIds.push(id);
    }
    if (normalizedProvider.normalizeToolSchemas) {
      getPluginInstance(record)?.admitFactory(normalizedProvider.normalizeToolSchemas, "tool");
    }
    registry.providers.push(
      createRegistration(record, {
        provider: { ...normalizedProvider, pluginRoot: record.rootDir },
      }),
    );
    invalidateProviderRegistryIndex(registry.providers);
    // Reserve catalog ownership without duplicating the discovery-owned model row builders.
    if (normalizedProvider.catalog || normalizedProvider.staticCatalog) {
      registerModelCatalogProvider(record, {
        provider: normalizedProvider.id,
        kinds: ["text"],
      });
    }
  };

  const registerAgentHarness = (
    record: PluginRecord,
    harness: AgentHarness,
    options?: AgentHarnessRegistrationOptions,
  ) => {
    const id = normalizeOptionalString(harness?.id) ?? "";
    if (!id) {
      reportRegistrationError(record, "agent harness registration missing id");
      return;
    }
    if (id === "openclaw") {
      reportRegistrationError(
        record,
        'agent harness id "openclaw" is reserved for the built-in runtime',
      );
      return;
    }
    if (typeof harness.supports !== "function" || typeof harness.runAttempt !== "function") {
      reportRegistrationError(
        record,
        `agent harness "${id}" registration missing required runtime methods`,
      );
      return;
    }
    if (
      options?.nativeCompaction &&
      (!canClaimReservedCommandOwnership(record) ||
        id !== "codex" ||
        typeof options.nativeCompaction !== "function")
    ) {
      reportRegistrationError(
        record,
        'native compaction requires the registry-owned "codex" harness',
      );
      return;
    }
    const existing = registry.agentHarnesses.find((entry) => entry.harness.id === id);
    if (existing) {
      const ownerDetail = existing.pluginId ? ` (owner: ${existing.pluginId})` : "";
      reportRegistrationError(record, `agent harness already registered: ${id}${ownerDetail}`);
      return;
    }
    if (harness.acquireMcpAppRuntime) {
      // oxlint-disable-next-line typescript/unbound-method -- Record factory identity; executable views bind the original receiver.
      getPluginInstance(record)?.admitFactory(harness.acquireMcpAppRuntime);
    }
    const normalizedHarness = { ...harness, id, pluginId: harness.pluginId ?? record.id };
    record.agentHarnessIds.push(id);
    registry.agentHarnesses.push(
      createRegistration(record, {
        harness: normalizedHarness,
        ...(options?.nativeCompaction ? { nativeCompaction: options.nativeCompaction } : {}),
      }),
    );
  };

  const registerCliBackend = (record: PluginRecord, backend: CliBackendPlugin) => {
    const id = backend.id.trim();
    if (!id) {
      reportRegistrationError(record, "cli backend registration missing id");
      return;
    }
    const existing = registry.cliBackends.find((entry) => entry.backend.id === id);
    if (existing) {
      reportRegistrationError(
        record,
        `cli backend already registered: ${id} (${existing.pluginId})`,
      );
      return;
    }
    warnOnMissingCliBackendModelProvider(backend, (message) =>
      reportRegistrationWarning(record, message),
    );
    if (backend.prepareExecution) {
      getPluginInstance(record)?.admitFactory(backend.prepareExecution);
    }
    registry.cliBackends.push(
      createRegistration(record, {
        builtWithOpenClawVersion: record.builtWithOpenClawVersion,
        backend: { ...backend, id },
      }),
    );
    record.cliBackendIds.push(id);
  };

  const registerEmbeddingProvider = (record: PluginRecord, adapter: EmbeddingProviderAdapter) => {
    const id = adapter.id.trim();
    if (!id) {
      reportRegistrationError(record, "embedding provider registration missing id");
      return;
    }
    if (!(record.contracts?.embeddingProviders ?? []).includes(id)) {
      reportRegistrationError(
        record,
        `plugin must declare contracts.embeddingProviders for adapter: ${id}`,
      );
      return;
    }
    const coreEntry = getCoreEmbeddingProvider(id);
    const existing =
      coreEntry ?? registry.embeddingProviders.find((entry) => entry.provider.id === id);
    if (existing) {
      const ownerPluginId =
        "ownerPluginId" in existing
          ? existing.ownerPluginId
          : "pluginId" in existing
            ? existing.pluginId
            : undefined;
      const ownerDetail = ownerPluginId ? ` (owner: ${ownerPluginId})` : "";
      reportRegistrationError(record, `embedding provider already registered: ${id}${ownerDetail}`);
      return;
    }
    getPluginInstance(record)?.admitFactory(adapter.create);
    registry.embeddingProviders.push(
      createRegistration(record, {
        provider: adapter,
      }),
    );
    if (!record.embeddingProviderIds.includes(id)) {
      record.embeddingProviderIds.push(id);
    }
  };

  const createProviderLikeRegistrar =
    <T extends { id: string }>(params: {
      kindLabel: string;
      factory?: (provider: T) => ((...args: never[]) => unknown) | undefined;
      factoryResult?: "tool";
      registrations: Array<PluginOwnedProviderRegistration<T>>;
      ownedIds: (record: PluginRecord) => string[];
      catalogKinds?: Parameters<typeof registerModelCatalogProvider>[1]["kinds"];
    }) =>
    (record: PluginRecord, provider: T): boolean | void => {
      const id = provider.id.trim();
      const { kindLabel } = params;
      if (!id) {
        reportRegistrationError(record, `${kindLabel} registration missing id`);
        return params.catalogKinds ? undefined : false;
      }
      const existing = params.registrations.find((entry) => entry.provider.id === id);
      if (existing) {
        reportRegistrationError(
          record,
          `${kindLabel} already registered: ${id} (${existing.pluginId})`,
        );
        return params.catalogKinds ? undefined : false;
      }
      const ownedIds = params.ownedIds(record);
      if (!ownedIds.includes(id)) {
        ownedIds.push(id);
      }
      const factory = params.factory?.(provider);
      if (factory) {
        (getPluginValueInstance(factory) ?? getPluginInstance(record))?.admitFactory(
          factory,
          params.factoryResult,
        );
      }
      params.registrations.push(
        createIdentityRegistration(record, {
          provider,
        }),
      );
      if (params.catalogKinds) {
        registerModelCatalogProvider(record, { provider: provider.id, kinds: params.catalogKinds });
        return;
      }
      return true;
    };

  const createContractProviderRegistrar =
    <T>(
      kind: "worker" | "storage",
      registrations: Map<string, PluginOwnedProviderRegistration<T>>,
      validate: (
        provider: T,
        declaredIds: readonly string[],
      ) => { ok: true; id: string } | { ok: false; message: string },
      admit?: (record: PluginRecord, provider: T) => void,
    ) =>
    (record: PluginRecord, provider: T) => {
      const validation = validate(provider, record.contracts?.[`${kind}Providers`] ?? []);
      if (!validation.ok) {
        reportRegistrationError(record, validation.message);
        return;
      }
      const { id } = validation;
      const existing = registrations.get(id);
      if (existing) {
        reportRegistrationError(
          record,
          `${kind} provider already registered: ${id} (${existing.pluginId})`,
        );
        return;
      }
      admit?.(record, provider);
      registrations.set(id, createRegistration(record, { provider }));
    };

  return {
    registerProvider,
    registerAgentHarness,
    registerCliBackend,
    registerEmbeddingProvider,
    registerWorkerProvider: createContractProviderRegistrar(
      "worker",
      registry.workerProviders,
      validateWorkerProviderContract,
    ),
    registerStorageProvider: createContractProviderRegistrar(
      "storage",
      registry.storageProviders,
      validateStorageProviderContract,
      (record, provider) => getPluginInstance(record)?.admitFactory(provider.open),
    ),
    registerSpeechProvider: createProviderLikeRegistrar({
      kindLabel: "speech provider",
      factory: (provider) => provider.streamSynthesize,
      registrations: registry.speechProviders,
      ownedIds: (record) => record.speechProviderIds,
      catalogKinds: ["voice"],
    }),
    registerRealtimeTranscriptionProvider: createProviderLikeRegistrar({
      kindLabel: "realtime transcription provider",
      factory: (provider) => provider.createSession,
      registrations: registry.realtimeTranscriptionProviders,
      ownedIds: (record) => record.realtimeTranscriptionProviderIds,
      catalogKinds: ["voice"],
    }),
    registerRealtimeVoiceProvider: createProviderLikeRegistrar({
      kindLabel: "realtime voice provider",
      factory: (provider) => provider.createBridge,
      registrations: registry.realtimeVoiceProviders,
      ownedIds: (record) => record.realtimeVoiceProviderIds,
      catalogKinds: ["voice"],
    }),
    registerMediaUnderstandingProvider: createProviderLikeRegistrar({
      kindLabel: "media provider",
      registrations: registry.mediaUnderstandingProviders,
      ownedIds: (record) => record.mediaUnderstandingProviderIds,
    }),
    registerTranscriptSourceProvider: createProviderLikeRegistrar({
      kindLabel: "transcripts source provider",
      factory: (provider) => provider.watchOccupancy,
      registrations: registry.transcriptSourceProviders,
      ownedIds: (record) => record.transcriptSourceProviderIds,
    }),
    registerImageGenerationProvider: createProviderLikeRegistrar({
      kindLabel: "image-generation provider",
      registrations: registry.imageGenerationProviders,
      ownedIds: (record) => record.imageGenerationProviderIds,
      catalogKinds: ["image_generation"],
    }),
    registerVideoGenerationProvider: createProviderLikeRegistrar({
      kindLabel: "video-generation provider",
      registrations: registry.videoGenerationProviders,
      ownedIds: (record) => record.videoGenerationProviderIds,
      catalogKinds: ["video_generation"],
    }),
    registerMusicGenerationProvider: createProviderLikeRegistrar({
      kindLabel: "music-generation provider",
      registrations: registry.musicGenerationProviders,
      ownedIds: (record) => record.musicGenerationProviderIds,
      catalogKinds: ["music_generation"],
    }),
    registerWebFetchProvider: createProviderLikeRegistrar({
      kindLabel: "web fetch provider",
      factory: (provider) => provider.createTool,
      factoryResult: "tool",
      registrations: registry.webFetchProviders,
      ownedIds: (record) => record.webFetchProviderIds,
    }),
    registerWebSearchProvider: createProviderLikeRegistrar({
      kindLabel: "web search provider",
      factory: (provider) => provider.createTool,
      factoryResult: "tool",
      registrations: registry.webSearchProviders,
      ownedIds: (record) => record.webSearchProviderIds,
    }),
    registerMigrationProvider: createProviderLikeRegistrar({
      kindLabel: "migration provider",
      factory: (provider) => provider.prepareApply,
      registrations: registry.migrationProviders,
      ownedIds: (record) => record.migrationProviderIds,
    }),
  };
}
