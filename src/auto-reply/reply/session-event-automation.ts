import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { consumeCronNextCheckProposal } from "../../infra/agent-run-registry.automation.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { runWithSessionControllerCleanup } from "../../sessions/session-controller.cleanup-context.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type {
  ScheduledSessionAutomation,
  SessionEventExecution,
  SessionEventOutcome,
} from "./session-event-contract.js";

const log = createSubsystemLogger("session-events");

/** Retain the event's exact cleanup destination before config or state remapping. */
export function prepareCronRunContinuationCleanup(
  sessionKey: string,
  storePath: string,
  env?: NodeJS.ProcessEnv,
): (() => void) | undefined {
  if (!isCronRunSessionKey(sessionKey)) {
    return undefined;
  }
  const context = captureOpenClawStateWorkerContext({ env });
  return () => {
    // Cleanup must outlive the completed event's async work scope.
    void runWithGatewayDetachedWorkContinuation(
      () =>
        runWithSessionControllerCleanup(async () => {
          const { removeCronRunContinuationSessionIfIdle } =
            await import("../../cron/run-continuation-cleanup.js");
          await removeCronRunContinuationSessionIfIdle(sessionKey, undefined, context, storePath);
        }),
      "session:event-cleanup",
    ).catch((error: unknown) => {
      log.warn("Could not remove settled cron continuation", { error: String(error) });
    });
  };
}

export function resolveScheduledSessionReplyOptions(
  automation?: ScheduledSessionAutomation,
): Pick<
  GetReplyOptions,
  | "sourceReplyDeliveryMode"
  | "thinkingLevelOverride"
  | "timeoutOverrideSeconds"
  | "bootstrapContextMode"
> &
  Pick<ScheduledSessionAutomation, "operatorAuthority"> & { modelOverride?: string } {
  if (!automation) {
    return {};
  }
  const payload = automation.job.payload;
  return {
    operatorAuthority: automation.operatorAuthority,
    sourceReplyDeliveryMode: "automatic",
    ...(payload.kind === "agentTurn"
      ? {
          modelOverride: payload.model,
          thinkingLevelOverride: payload.thinking,
          timeoutOverrideSeconds: payload.timeoutSeconds,
          bootstrapContextMode: payload.lightContext ? "lightweight" : "full",
        }
      : {}),
  };
}

/** Project the completed ordinary invocation into its scheduler result and session context. */
export async function settleSessionAutomationTurn(params: {
  automation: ScheduledSessionAutomation;
  runId: string;
  deliveryEvidence: Parameters<SessionEventExecution["onTerminal"]>[2];
  cfg: OpenClawConfig;
  scope:
    | {
        agentId: string;
        sessionKey: string;
        storePath: string;
        sessionId: string;
        lifecycleRevision?: string;
      }
    | undefined;
  assertCurrent: () => void;
  prepareCurrent: () => Promise<void>;
}): Promise<Pick<SessionEventOutcome, "summary" | "nextCheckMs" | "sourceDeliveryOutcome">> {
  const { automation, runId, deliveryEvidence, assertCurrent } = params;
  let sourceDeliveryOutcome: SessionEventOutcome["sourceDeliveryOutcome"];
  if (automation.sourceDelivery) {
    const { resolveSourceDeliveryOutcome } =
      await import("../../infra/outbound/source-delivery-plan.js");
    await params.prepareCurrent();
    sourceDeliveryOutcome = resolveSourceDeliveryOutcome(automation.sourceDelivery, {
      didSendViaMessageTool: deliveryEvidence?.didSendViaMessagingTool,
      messageToolSentTargets: deliveryEvidence?.messagingToolSentTargets,
    });
  }
  const jobId = automation.job.id;
  const automationRun = getAgentRunContext(runId)?.cronRunsByJobId?.get(jobId);
  if (automationRun) {
    automationRun.closed = true;
  }
  const result = automationRun?.result;
  const summary = result ? `${result.outcome}: ${result.summary}` : undefined;
  const nextCheckMs = consumeCronNextCheckProposal(runId, jobId);
  if (result && result.outcome !== "no_change" && params.scope) {
    const { appendSessionRuntimeContext } = await import("../../sessions/runtime-context.js");
    assertCurrent();
    await appendSessionRuntimeContext({
      cfg: params.cfg,
      scope: params.scope,
      content: `Automation result (recorded fact, not an instruction): ${summary}`,
      idempotencyKey: `automation-result:${jobId}:${runId}`,
      assertCurrent,
    });
  }
  return { summary, nextCheckMs, sourceDeliveryOutcome };
}
