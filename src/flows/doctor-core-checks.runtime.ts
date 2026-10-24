import { formatUnsupportedNodeVersionMessage } from "../../node-version.mjs";
import { tryResolveSoleAgentId } from "../agents/agent-scope.js";
import { shouldManageGatewayService } from "../commands/doctor-service-repair-policy.js";
import { collectUnavailableAgentSkills } from "../commands/doctor-skills-core.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { resolveNodeRuntimeInfo } from "../daemon/runtime-paths.js";
import { summarizeGatewayServiceLayout } from "../daemon/service-layout.js";
import { getSystemdCgroupHygieneSummary } from "../daemon/service-runtime.js";
import { resolveGatewayService, readGatewayServiceState } from "../daemon/service.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatInstallOwnerMessage, readInstallOwner } from "../infra/install-owner.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import {
  formatLocalAudioSelection,
  inspectLocalAudioSelection,
} from "../media-understanding/local-audio.js";
import type { ProviderCatalogOrder, ProviderPlugin } from "../plugins/types.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import type { HealthCheckContext, HealthFinding } from "./health-checks.js";

const PROVIDER_CATALOG_ORDERS = ["simple", "profile", "paired", "late"] as const;
const PROVIDER_CATALOG_ORDER_SET = new Set<ProviderCatalogOrder>(PROVIDER_CATALOG_ORDERS);

export function detectUnavailableSkills(cfg: OpenClawConfig, workspaceDir: string) {
  const report = buildWorkspaceSkillStatus(workspaceDir, {
    config: cfg,
    agentId: tryResolveSoleAgentId(cfg),
  });
  return collectUnavailableAgentSkills(report);
}

export async function collectLocalAudioAccelerationFindings(): Promise<readonly HealthFinding[]> {
  const selection = await inspectLocalAudioSelection();
  const available = selection.candidates.filter((candidate) => candidate.available);
  if (available.length === 0) {
    return [];
  }
  const summary = formatLocalAudioSelection(selection);
  if (summary) {
    return [
      {
        checkId: "core/doctor/local-audio-acceleration",
        severity: "info",
        message: `Local STT auto-selection: ${summary}.`,
        path: "tools.media.models",
      },
    ];
  }
  const blockers = available
    .map((candidate) => `${candidate.command}: ${candidate.reason}`)
    .join("; ");
  return [
    {
      checkId: "core/doctor/local-audio-acceleration",
      severity: "info",
      message: `Local STT commands were found but none are ready for auto-selection: ${blockers}.`,
      path: "tools.media.models",
      fixHint:
        "Install the matching local model/runtime, or configure an audio-capable tools.media.models CLI entry.",
    },
  ];
}

export async function collectGatewayDaemonFindings(
  ctx: Pick<HealthCheckContext, "cfg">,
): Promise<readonly HealthFinding[]> {
  if (ctx.cfg.gateway?.mode === "remote" || !(await shouldManageGatewayService())) {
    return [];
  }
  const service = resolveGatewayService();
  const state = await readGatewayServiceState(service, { env: process.env });
  const layout = await summarizeGatewayServiceLayout(state.command);
  const serviceOwner = await readInstallOwner(
    layout?.packageRootReal ?? layout?.packageRoot ?? null,
  );
  const ownerHint = serviceOwner ? formatInstallOwnerMessage(serviceOwner) : undefined;
  const findings: HealthFinding[] = [];
  const warn = (message: string, fixHint: string, path = state.command?.sourcePath) => {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message,
      path,
      target: service.label,
      fixHint,
    });
  };
  if (state.loadState.status === "unknown") {
    warn(
      `Gateway service status could not be determined: ${state.loadState.detail}`,
      ownerHint ??
        service.unsupportedReason ??
        "Run `openclaw gateway status --deep`, restore service-manager access, and retry.",
    );
    return findings;
  }
  if (!state.installed) {
    const owner = await readInstallOwner(
      await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url, argv1: process.argv[1] }),
    );
    if (owner) {
      return [
        {
          checkId: "core/doctor/gateway-daemon",
          severity: "info",
          message: formatInstallOwnerMessage(owner),
          target: owner.displayName,
        },
      ];
    }
    warn(
      "Gateway service is not installed.",
      "Run `openclaw gateway install` to install the service.",
      "gateway.mode",
    );
    return findings;
  }
  const nodePath = state.command?.programArguments[0];
  if (nodePath && isNodeRuntime(nodePath)) {
    const runtime = await resolveNodeRuntimeInfo(nodePath, state.env);
    const message =
      runtime.status === "probe-failed" ? runtime.error.message : runtime.capabilityError;
    if (message) {
      findings.push({
        checkId: "core/doctor/gateway-daemon",
        severity: runtime.status === "supported" ? "info" : "warning",
        message,
        path: state.command?.sourcePath,
        target: nodePath,
        ...(runtime.status !== "supported"
          ? {
              fixHint:
                ownerHint ??
                [
                  ...(runtime.status === "unsupported"
                    ? [formatUnsupportedNodeVersionMessage(runtime.version)]
                    : []),
                  "Repair the Node runtime, then run `openclaw gateway install`.",
                ].join("\n"),
            }
          : {}),
      });
    }
  }
  if (state.loadState.status === "not-loaded") {
    warn(
      "Gateway service is installed but not loaded.",
      ownerHint ?? "Start the installed service with `openclaw gateway start`.",
    );
  }
  const runtime = state.runtime;
  const status = runtime?.status ?? runtime?.state ?? runtime?.subState;
  if (state.loadState.status === "loaded" && !state.running) {
    warn(
      status
        ? `Gateway service runtime is ${status}, not running.`
        : "Gateway service is loaded but runtime status could not confirm it is running.",
      "Run `openclaw gateway status --deep` to inspect the service before choosing a recovery action.",
    );
  }
  if (state.runtime?.missingGuiSession) {
    warn(
      "Gateway service cannot attach to the user GUI session.",
      state.runtime.detail ?? "Log into a GUI session, then rerun doctor.",
    );
  }
  if (state.runtime?.missingUnit) {
    warn(
      "Gateway service supervision metadata is missing.",
      ownerHint ?? state.runtime.detail ?? "Reinstall or reload the Gateway service.",
    );
  }
  const hygiene = getSystemdCgroupHygieneSummary(state.runtime?.systemd);
  if (hygiene) {
    warn(
      `Gateway systemd service has risky ${hygiene}.`,
      "Repair the systemd unit so stale child processes are cleaned up reliably.",
    );
  }
  return findings;
}

function providerCatalogProjectionFinding(
  params: { providerId: string; pluginId?: string },
  message: string,
  error: unknown,
): HealthFinding {
  const path = params.pluginId ? `plugins.entries.${params.pluginId}` : undefined;
  return {
    checkId: "core/doctor/provider-catalog-projection",
    severity: "error",
    message,
    ...(path ? { path } : {}),
    target: params.providerId,
    requirement: formatErrorMessage(error),
    fixHint:
      "Fix the plugin provider catalog hook or disable the plugin, then rerun doctor before relying on model discovery.",
  };
}

function isReadableRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isTrimmedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function groupProviderCatalogsForDoctor(providers: readonly ProviderPlugin[]): {
  findings: HealthFinding[];
  byOrder: Record<ProviderCatalogOrder, ProviderPlugin[]>;
} {
  const findings: HealthFinding[] = [];
  const byOrder: Record<ProviderCatalogOrder, ProviderPlugin[]> = {
    simple: [],
    profile: [],
    paired: [],
    late: [],
  };
  for (const provider of providers) {
    let order: ProviderCatalogOrder = "late";
    try {
      const declaredOrder = provider.staticCatalog?.order ?? "late";
      if (PROVIDER_CATALOG_ORDER_SET.has(declaredOrder)) {
        order = declaredOrder;
      } else {
        findings.push(
          providerCatalogProjectionFinding(
            { providerId: provider.id, pluginId: provider.pluginId },
            `Provider catalog ${provider.id} order is invalid during doctor validation.`,
            new Error("order must be simple, profile, paired, or late"),
          ),
        );
      }
    } catch (error) {
      findings.push(
        providerCatalogProjectionFinding(
          { providerId: provider.id, pluginId: provider.pluginId },
          `Provider catalog ${provider.id} order cannot be read during doctor validation.`,
          error,
        ),
      );
    }
    byOrder[order].push(provider);
  }
  for (const order of PROVIDER_CATALOG_ORDERS) {
    byOrder[order].sort((a, b) => a.label.localeCompare(b.label));
  }
  return { findings, byOrder };
}

export async function collectProviderCatalogProjectionFindings(
  cfg: OpenClawConfig,
  workspaceDir?: string,
): Promise<readonly HealthFinding[]> {
  const { runProviderStaticCatalog } = await import("../plugins/provider-discovery.js");
  const { resolvePluginProvidersCore } = await import("../plugins/providers.runtime.js");
  const env = process.env;
  let providers: Awaited<ReturnType<typeof resolvePluginProvidersCore>>;
  try {
    providers = resolvePluginProvidersCore({
      config: cfg,
      workspaceDir,
      env,
      includeUntrustedWorkspacePlugins: false,
    });
  } catch (error) {
    return [
      {
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        message: "Provider catalog hooks could not be loaded for doctor validation.",
        requirement: formatErrorMessage(error),
        fixHint: "Fix plugin provider discovery loading, then rerun doctor.",
      },
    ];
  }

  const grouped = groupProviderCatalogsForDoctor(providers);
  const findings = [...grouped.findings];
  for (const order of PROVIDER_CATALOG_ORDERS) {
    for (const provider of grouped.byOrder[order]) {
      const finding = (message: string, reason: string, providerId = provider.id) =>
        providerCatalogProjectionFinding(
          { providerId, pluginId: provider.pluginId },
          `Provider catalog ${providerId} ${message}.`,
          new Error(reason),
        );
      const collectModels = (value: Record<string, unknown>, providerId = provider.id) => {
        const models = value.models;
        if (!Array.isArray(models)) {
          findings.push(
            finding(
              "models value is invalid during doctor validation",
              "models must be an array",
              providerId,
            ),
          );
          return;
        }
        for (const [index, model] of models.entries()) {
          const modelId = isReadableRecord(model) ? model.id : undefined;
          if (!isTrimmedNonEmptyString(modelId)) {
            findings.push(
              finding(
                `model row ${index} has an invalid model id`,
                "model id must be a non-empty trimmed string",
                providerId,
              ),
            );
          }
          const modelName = isReadableRecord(model) ? model.name : undefined;
          if (modelName !== undefined && typeof modelName !== "string") {
            findings.push(
              finding(
                `model row ${index} has an invalid model name`,
                "model name must be a string when present",
                providerId,
              ),
            );
          }
        }
      };
      try {
        const staticCatalog = provider.staticCatalog;
        if (staticCatalog === undefined) {
          continue;
        }
        if (!isReadableRecord(staticCatalog) || typeof staticCatalog.run !== "function") {
          findings.push(
            finding(
              "static catalog hook is invalid during doctor validation",
              "static catalog run must be a function",
            ),
          );
          continue;
        }
        const result: unknown = await runProviderStaticCatalog({ provider });
        if (result == null) {
          continue;
        }
        if (!isReadableRecord(result)) {
          findings.push(
            finding("result is invalid during doctor validation", "result must be an object"),
          );
          continue;
        }
        if ("provider" in result) {
          if (isReadableRecord(result.provider)) {
            collectModels(result.provider);
          } else {
            findings.push(
              finding(
                "provider value is invalid during doctor validation",
                "provider must be an object",
              ),
            );
          }
          continue;
        }
        if (!isReadableRecord(result.providers)) {
          findings.push(
            finding(
              "result is invalid during doctor validation",
              "result must include provider or providers object",
            ),
          );
          continue;
        }
        for (const providerId of Object.keys(result.providers)) {
          if (!isTrimmedNonEmptyString(providerId)) {
            findings.push(
              finding(
                "provider key is invalid during doctor validation",
                "provider key must be a non-empty trimmed string",
              ),
            );
            continue;
          }
          const config = result.providers[providerId];
          if (!isReadableRecord(config)) {
            findings.push(
              finding(
                "provider entry is invalid during doctor validation",
                "provider entry must be an object",
                providerId,
              ),
            );
            continue;
          }
          collectModels(config, providerId);
        }
      } catch (error) {
        findings.push(
          providerCatalogProjectionFinding(
            { providerId: provider.id, pluginId: provider.pluginId },
            `Provider catalog ${provider.id} failed during doctor validation.`,
            error,
          ),
        );
      }
    }
  }
  return findings;
}
