import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import type { AgentFallbackCandidateCommonParams } from "./agent-runner-fallback-cycle.types.js";

export async function startScheduledCandidate(
  params: AgentFallbackCandidateCommonParams,
  lifecycleBackstop: AgentLifecycleTerminalBackstop,
  getSessionKey: () => string | undefined,
): Promise<void> {
  const turn = params.turn;
  try {
    await turn.followupRun.run.internalEventExecution?.beforeScheduledStart?.(params.runId);
    params.runAbortSignal?.throwIfAborted();
    turn.followupRun.run.internalEventExecution?.assertCurrent?.();
    const automation = turn.followupRun.run.scheduledAutomation;
    const sessionKey = getSessionKey();
    if (automation && sessionKey) {
      automation.onExecutionStarted?.({
        runId: params.runId,
        sessionId: turn.followupRun.run.sessionId,
        sessionKey,
        provider: params.provider,
        model: params.model,
        ...(params.isFallbackRetry ? { isFallback: true } : {}),
      });
    }
  } catch (error) {
    if (!params.hasAgentRunStarted()) {
      lifecycleBackstop.note({
        stream: "lifecycle",
        data: { phase: "finishing", executionStarted: false, providerStarted: false },
      });
    }
    throw error;
  }
}
