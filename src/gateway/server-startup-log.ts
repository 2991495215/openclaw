import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import chalk from "chalk";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { formatFastModeValue, resolveFastModeState } from "../agents/fast-mode.js";
import {
  buildConfiguredModelCatalog,
  resolveConfiguredModelRef,
} from "../agents/model-selection-shared.js";
import { resolveConfiguredThinkingDefaultCore } from "../agents/model-thinking-default-core.js";
import { resolveThinkingDefault } from "../agents/model-thinking-default.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ensureSqliteLibrarySelected,
  getSqliteRuntimeCapabilities,
} from "../infra/bun-sqlite-library.js";
import { getTrackedWorkerLifecycleSnapshot } from "../infra/worker-cpu.js";
import { getWorkerComputeCapacity } from "../infra/worker-task-capacity.js";
import { getResolvedLoggerSettings } from "../logging.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { collectEnabledInsecureOrDangerousFlagsFromCurrentSnapshot } from "../security/dangerous-config-flags-current.js";

/** Emit startup summary lines after Gateway bind and plugin loading complete. */
export async function logGatewayStartup(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRecords: readonly PluginManifestRecord[];
  loadedPluginIds: readonly string[];
  startupStartedAt?: number;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string) => void };
  isNixMode: boolean;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}) {
  const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
    cfg: params.cfg,
    agentId: tryResolveAmbientOwnerAgentId(params.cfg),
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const modelConfig = params.cfg;
  const modelRef = `${agentProvider}/${agentModel}`;
  const soleAgentId = tryResolveAmbientOwnerAgentId(modelConfig);
  let thinking = resolveConfiguredThinkingDefaultCore({
    cfg: modelConfig,
    provider: agentProvider,
    model: agentModel,
    agentId: soleAgentId,
  });
  if (thinking === undefined) {
    const configuredCatalog = buildConfiguredModelCatalog({ cfg: modelConfig });
    // Catalog reasoning=false is authoritative; avoid loading provider policy artifacts
    // only to discard their default below.
    if (
      configuredCatalog.some(
        (entry) =>
          entry.provider === agentProvider && entry.id === agentModel && entry.reasoning === false,
      )
    ) {
      thinking = "off";
    } else {
      thinking = resolveThinkingDefault({
        cfg: modelConfig,
        agentId: soleAgentId,
        provider: agentProvider,
        model: agentModel,
        catalog: configuredCatalog,
      });
    }
  }
  const fast = resolveFastModeState({
    cfg: modelConfig,
    provider: agentProvider,
    model: agentModel,
    agentId: soleAgentId,
  });
  const modelDetails = `thinking=${thinking}, fast=${formatFastModeValue(fast.mode)}`;
  params.log.info(`agent model: ${modelRef} (${modelDetails})`, {
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)} (${modelDetails})`,
  });
  const startupDurationMs =
    typeof params.startupStartedAt === "number" ? Date.now() - params.startupStartedAt : null;
  const startupDurationLabel =
    startupDurationMs == null ? null : `${(startupDurationMs / 1000).toFixed(1)}s`;
  const pluginIds = normalizeSortedUniqueStringEntries(params.loadedPluginIds);
  const pluginSummary =
    pluginIds.length === 0
      ? "0 plugins"
      : `${pluginIds.length} ${pluginIds.length === 1 ? "plugin" : "plugins"}: ${pluginIds.join(", ")}`;
  const readyDetails = !startupDurationLabel
    ? pluginSummary
    : pluginIds.length === 0
      ? `${pluginSummary}, ${startupDurationLabel}`
      : `${pluginSummary}; ${startupDurationLabel}`;
  params.log.info(`http server listening (${readyDetails})`);
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  params.log.info(
    "Older local CLI/SDK versions can bypass Gateway state mutation routing. Use matching CLI/SDK and Gateway versions; direct state writes from another process while this Gateway owns state are unsupported.",
  );
  const sqliteLibrary = ensureSqliteLibrarySelected();
  params.log.info(
    `native runtime: ${JSON.stringify({
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      bun: process.versions.bun,
      v8: process.versions.v8,
      uv: process.versions.uv,
      openssl: process.versions.openssl,
      sqlite: sqliteLibrary.source === "runtime" ? process.versions.sqlite : sqliteLibrary.version,
      sqliteClose: getSqliteRuntimeCapabilities(),
    })}`,
  );
  params.log.info(
    `worker startup state: ${JSON.stringify({
      ...getTrackedWorkerLifecycleSnapshot(),
      compute: getWorkerComputeCapacity().getSnapshot(),
    })}`,
  );
  if (sqliteLibrary.source !== "runtime") {
    params.log.info(
      `SQLite: using ${sanitizeForLog(sqliteLibrary.path)} (${sqliteLibrary.version}, extension loading enabled)`,
    );
  } else if (sqliteLibrary.ignoredOverride) {
    params.log.warn(`SQLite: ${sqliteLibrary.ignoredOverride}; override ignored`);
  }
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }

  const { cfg, activationSourceConfig, ambientEnvTriggers, env, manifestRecords } = params;
  const [blockerModule, presencePolicyModule] = await Promise.all([
    import("../commands/doctor/shared/channel-plugin-blockers.js"),
    import("../plugins/channel-presence-policy.js"),
  ]);
  const hits = blockerModule.scanConfiguredChannelPluginBlockers(cfg, env, activationSourceConfig, {
    manifestRecords,
    ambientEnvTriggers,
  });
  const blockerWarnings = blockerModule
    .collectConfiguredChannelPluginBlockerWarnings(hits)
    .map((warning) => `configured channel warning: ${warning.replace(/^[-]\s*/u, "")}`);
  const missingOwnerWarnings = presencePolicyModule
    .resolveConfiguredChannelPresencePolicy({
      config: cfg,
      activationSourceConfig,
      env,
      includePersistedAuthState: false,
      ambientEnvTriggers,
      manifestRecords,
    })
    .filter((entry) => !entry.effective && entry.blockedReasons.includes("no-channel-owner"))
    .map((entry) => {
      const channelId = sanitizeForLog(entry.channelId);
      const reasons = normalizeSortedUniqueStringEntries(entry.blockedReasons).join(", ");
      return (
        `configured channel warning: channels.${channelId} is configured but no channel plugin ` +
        `is installed or loadable (${reasons}). Run \`openclaw doctor --fix\` or install the ` +
        "channel plugin before relying on this channel."
      );
    });
  const suppressedAmbientChannelIds =
    ambientEnvTriggers === "suppress"
      ? presencePolicyModule.listAmbientOnlyConfiguredChannelIds({
          config: cfg,
          activationSourceConfig,
          env,
          includePersistedAuthState: false,
          manifestRecords,
        })
      : [];
  const suppressionWarning: string[] = [];
  if (suppressedAmbientChannelIds.length > 0) {
    const safeChannelIds = normalizeSortedUniqueStringEntries(suppressedAmbientChannelIds).map(
      (channelId) => sanitizeForLog(channelId),
    );
    suppressionWarning.push(
      `gateway suppressed ambient channel auto-configuration for ${safeChannelIds.length} ` +
        `${safeChannelIds.length === 1 ? "channel" : "channels"}: ${safeChannelIds.join(", ")}. ` +
        "Configure channels.<id> (openclaw channels add <id>) to enable the channel, or pass " +
        "--ambient-channels to allow ambient env credentials.",
    );
  }
  for (const warning of [...suppressionWarning, ...blockerWarnings, ...missingOwnerWarnings]) {
    params.log.warn(warning);
  }

  const enabledDangerousFlags =
    collectEnabledInsecureOrDangerousFlagsFromCurrentSnapshot(params.cfg) ??
    (await import("../security/dangerous-config-flags.js")).collectEnabledInsecureOrDangerousFlags(
      params.cfg,
    );
  if (enabledDangerousFlags.length > 0) {
    const warning =
      `security warning: dangerous config flags enabled: ${enabledDangerousFlags.join(", ")}. ` +
      "Run `openclaw security audit`.";
    params.log.warn(warning);
  }
}
