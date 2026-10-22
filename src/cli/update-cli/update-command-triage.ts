import { randomUUID } from "node:crypto";
import { isCancel } from "@clack/prompts";
import { confirm, select } from "../../commands/configure.shared.js";
import { sanitizeTriageUpdateFailure } from "../../commands/triage-update.js";
import { resolveStateDir } from "../../config/paths.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveInstallationTarget } from "../../infra/installation-target-context.js";
import { readControlPlaneUpdateSentinelMeta } from "../../infra/update-control-plane-sentinel.js";
import { preparePublicUpdateFailureIdentifiers } from "../../infra/update-failure-public-identifiers.js";
import { writeTriageUpdateFailure } from "../../infra/update-failure-report-artifact.js";
import {
  prepareUpdateFailureReport,
  submitUpdateFailureReport,
  type UpdateFailureReportSubmitResult,
  type PreparedUpdateFailureReport,
} from "../../infra/update-failure-report.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateTriageTarget as TriageTarget } from "../../infra/update-triage.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { classifyUpdateOutcome, isVerifiedUpdateRollback } from "../../shared/update-outcome.js";
import { formatInstallationTargetCommand } from "../installation-target-format.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { isTerminalInteractive } from "../terminal-interactivity.js";
import { resolveNodeRunner, resolveUpdateRoot, type UpdateCommandOptions } from "./shared.js";
import {
  reportUpdateCommandPendingRecovery,
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";

export type UpdateTriageTarget = TriageTarget & { failureResult?: UpdateRunResult };

type UpdateFailureTriageOptions = Pick<UpdateCommandOptions, "json" | "yes" | "dryRun" | "run"> & {
  invocationCwd?: string;
};

type UpdateFailureAction = "triage" | "report" | "status" | "browser" | "dismiss";

function renderSubmissionResult(
  result: UpdateFailureReportSubmitResult,
  browserRequested: boolean,
): string[] {
  if (result.status === "created") {
    return [`Created GitHub issue: ${result.url}`, ...(result.message ? [result.message] : [])];
  }
  if (result.status === "fallback") {
    return [
      browserRequested
        ? result.message
        : `GitHub issue creation was unavailable: ${result.message}`,
      ...(browserRequested ? [`Prefilled issue: ${result.fallbackUrl}`] : []),
      `Saved sanitized report: ${result.savedReportPath}`,
    ];
  }
  if (result.status === "retryable") {
    return [result.message];
  }
  return [
    result.message,
    ...(result.url ? [`Existing issue: ${result.url}`] : []),
    ...(browserRequested && result.fallbackUrl
      ? [`Existing prefilled issue: ${result.fallbackUrl}`]
      : []),
  ];
}

export async function withUpdateFailureTriage(
  opts: UpdateFailureTriageOptions,
  target: UpdateTriageTarget,
  run: () => Promise<void>,
): Promise<void> {
  const handleFailure = await prepareUpdateCommandFailureTriage(opts, target);
  try {
    await run();
  } catch (error) {
    await handleFailure(error);
  }
}

/** Capture repair code and operator context before replacing the installation. */
export async function prepareUpdateCommandFailureTriage(
  opts: UpdateFailureTriageOptions,
  target: UpdateTriageTarget,
): Promise<(error: unknown) => Promise<void>> {
  // CLI and Gateway reports for an admitted run share its identity and state scope.
  // Standalone calls without an admitted run still own a fresh attempt.
  const updateAttemptId = opts.run?.runId ?? randomUUID();
  const mode = opts.json
    ? "json"
    : !opts.yes && isTerminalInteractive()
      ? "interactive"
      : "non-interactive";
  if (mode === "interactive") {
    await preparePublicUpdateFailureIdentifiers();
  }
  const { prepareUpdateFailureTriage } = await import("../../infra/update-triage.js");
  const runTriage = await prepareUpdateFailureTriage({
    mode,
    runtime: {
      ...defaultRuntime,
      log: opts.json ? defaultRuntime.error : defaultRuntime.log,
    },
    invocationCwd: opts.invocationCwd,
  });
  return async (error) => {
    if (error instanceof ExitError) {
      throw error;
    }
    // Recovery can replace files still owned by an uncertain command. Preserve
    // the original failure and retained executor for its recovery owner.
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    const causes = collectNestedErrorCandidates(error);
    const finalized = causes.find(
      (cause) => cause instanceof UpdateCommandFinalizedRecoveryFailure,
    );
    if (finalized) {
      return exitCliAfterOutput(defaultRuntime, finalized.exitCode);
    }
    const pending = causes.find((cause) => cause instanceof UpdateCommandPendingRecoveryFailure);
    if (pending) {
      return reportUpdateCommandPendingRecovery(pending, opts);
    }
    const reportedFailure = error instanceof UpdateCommandFailure;
    if (reportedFailure && error.result.reason === "invalid-dev-target") {
      return exitCliAfterOutput(defaultRuntime, error.exitCode);
    }
    const rollbackCompleted = reportedFailure && isVerifiedUpdateRollback(error.result);
    // A healthy restored installation needs only an explicit terminal choice,
    // never automatic diagnostics or a second managed-helper report.
    if (
      rollbackCompleted &&
      (mode !== "interactive" ||
        target.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" ||
        error.result.steps.some((step) => step.termination === "signal"))
    ) {
      return exitCliAfterOutput(defaultRuntime, error.exitCode);
    }
    // Post-core children return phase data; only their outer updater owns the final failure.
    if (
      (!reportedFailure || classifyUpdateOutcome(error.result) === "failed") &&
      !opts.dryRun &&
      target.env[POST_CORE_UPDATE_ENV] !== "1"
    ) {
      const failure = reportedFailure
        ? { result: error.result, ...(error.detail ? { error: error.detail } : {}) }
        : {
            ...(target.failureResult ? { result: target.failureResult } : {}),
            error: formatErrorMessage(error),
          };
      if (target.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1") {
        try {
          const meta = await readControlPlaneUpdateSentinelMeta(target.env);
          if (!meta?.triageContextPath) {
            throw new Error("Managed update triage context path is unavailable.", { cause: error });
          }
          const updateResultPath = await writeTriageUpdateFailure(failure, {
            env: target.env,
            ...(meta?.triageContextPath ? { outputPath: meta.triageContextPath } : {}),
          });
          defaultRuntime.error(
            `To start a repair agent, run ${formatInstallationTargetCommand(
              ["openclaw", "triage", "--run", "--update-result", updateResultPath],
              resolveInstallationTarget(target.env),
              { env: target.env },
            )}`,
          );
        } catch (exportError) {
          const diagnostic = sanitizeTriageUpdateFailure(
            { error: formatErrorMessage(exportError) },
            { env: target.env, stateDir: resolveStateDir(target.env) },
          );
          defaultRuntime.error(
            `Managed update failure diagnostics could not be saved: ${diagnostic.error}`,
          );
        }
      } else {
        let nextAction: "triage" | "handled" = "triage";
        if (mode === "interactive") {
          try {
            const reportEnv = opts.run?.env ?? target.env;
            const reportError = failure.error || undefined;
            const reportResult = failure.result;
            let prepared: PreparedUpdateFailureReport | undefined;
            let browserAvailable = false;
            let reportPending = false;
            const stateDir = resolveStateDir(reportEnv);
            nextAction = "handled";
            while (true) {
              const action = await select<UpdateFailureAction>({
                message: rollbackCompleted
                  ? "Update failed, but rollback completed successfully. Choose the next action"
                  : "Choose the next action for this failed update",
                ...(rollbackCompleted ? { initialValue: "dismiss" as const } : {}),
                options: [
                  { value: "triage", label: "Diagnose update failure" },
                  reportPending
                    ? { value: "status", label: "Check report status" }
                    : { value: "report", label: "Report update failure" },
                  ...(browserAvailable
                    ? [{ value: "browser" as const, label: "Report in browser" }]
                    : []),
                  { value: "dismiss", label: "Exit" },
                ],
              });
              if (isCancel(action) || action === "dismiss") {
                break;
              }
              if (action === "triage") {
                nextAction = "triage";
                break;
              }
              try {
                const result: UpdateRunResult = reportResult ?? {
                  status: "error",
                  mode: "unknown",
                  steps: [],
                  durationMs: 0,
                };
                if (!prepared) {
                  let recordedRun: ReturnType<typeof getUpdateRun>;
                  try {
                    recordedRun = getUpdateRun(updateAttemptId, { env: reportEnv });
                  } catch {
                    // A missing or locked ledger must not prevent reporting the direct failure.
                  }
                  prepared = await prepareUpdateFailureReport(
                    {
                      attemptId: updateAttemptId,
                      action: "cli",
                      ...(reportError ? { error: reportError } : {}),
                      result,
                      recordedRun,
                      ...(result.after?.upstreamRef ? { target: result.after.upstreamRef } : {}),
                    },
                    { env: reportEnv, stateDir },
                  );
                }
                defaultRuntime.log("Sanitized update failure report preview:");
                defaultRuntime.log(prepared.body);
                const confirmed = await confirm({
                  message:
                    action === "browser"
                      ? "Prepare a browser link to review and submit this report yourself?"
                      : action === "status"
                        ? "Check whether this report was submitted to openclaw/openclaw?"
                        : "Submit this sanitized report to openclaw/openclaw now?",
                  initialValue: false,
                });
                if (isCancel(confirmed) || !confirmed) {
                  defaultRuntime.log("Update failure report cancelled.");
                  break;
                }
                // A lost upload response must not retain an earlier browser-retry choice.
                browserAvailable = false;
                const submitted = await submitUpdateFailureReport(
                  prepared,
                  prepared.previewDigest,
                  {
                    env: reportEnv,
                    stateDir,
                    ...(action === "browser"
                      ? { publicationMode: "browser" as const }
                      : action === "status"
                        ? { publicationMode: "reconcile" as const }
                        : { allowBrowserFallback: false }),
                  },
                );
                reportPending = submitted.status === "pending";
                browserAvailable =
                  prepared.browserFallback.status === "available" &&
                  (submitted.status === "retryable" ||
                    submitted.status === "fallback" ||
                    (submitted.status === "duplicate" && Boolean(submitted.fallbackUrl)));
                for (const line of renderSubmissionResult(submitted, action === "browser")) {
                  defaultRuntime.log(line);
                }
                if (
                  submitted.status === "created" ||
                  (submitted.status === "duplicate" && submitted.url) ||
                  (action === "browser" && submitted.fallbackUrl)
                ) {
                  break;
                }
              } catch (submissionError) {
                defaultRuntime.error(
                  `Update failure report failed: ${formatErrorMessage(submissionError)}`,
                );
              }
            }
          } catch (reportError) {
            defaultRuntime.error(
              `Update failure report could not be prepared: ${formatErrorMessage(reportError)}`,
            );
            nextAction = "handled";
          }
        }
        if (nextAction === "triage") {
          await runTriage({
            failure,
            target:
              mode === "interactive"
                ? target
                : { ...target, nodeRunner: target.nodeRunner ?? resolveNodeRunner() },
            resolveRoot: resolveUpdateRoot,
          });
        }
      }
    }
    if (reportedFailure) {
      exitCliAfterOutput(defaultRuntime, error.exitCode);
    }
    throw error;
  };
}
