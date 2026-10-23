import { getPluginExecutionFrame } from "../plugins/plugin-instance-invocation.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";

export type AgentInputRecoveryAdmission = {
  isPending: (agentId: string) => boolean;
  waitForAgentInputRecovery: (
    agentId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<void> | undefined;
};

export type AgentInputRecoveryContext = {
  context?: { inputRecovery?: AgentInputRecoveryAdmission };
  resolveGatewayContext?: () => { inputRecovery?: AgentInputRecoveryAdmission } | undefined;
};

function resolveOwner(): AgentInputRecoveryAdmission | undefined {
  const scope = getPluginExecutionFrame()?.inputRecoveryContext;
  return (scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context)
    ?.inputRecovery;
}

export function isAgentInputRecoveryPending(agentId: string): boolean {
  return resolveOwner()?.isPending(agentId) ?? false;
}

/** Fresh sources wait before reservation; recovery itself never borrows this gate. */
export function waitForAgentInputRecovery(
  agentId: string,
  options: { signal?: AbortSignal; owner?: AgentInputRecoveryAdmission } = {},
): Promise<void> | undefined {
  const signals = [options.signal, getAsyncWorkSignal()].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return (options.owner ?? resolveOwner())?.waitForAgentInputRecovery(agentId, {
    signal: signals.length ? AbortSignal.any(signals) : undefined,
  });
}
