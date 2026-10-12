import {
  ErrorCodes,
  errorShape,
  validateAgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { createAgentTurnService } from "../agent-turn/agent-turn-service.js";
import type { AgentJobSession } from "../agent-turn/types.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import { createSessionListEntryFilter, isGatewayAdmin } from "../session-sharing.js";
import { agentRunHandler } from "./agent-run-handler.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const agentWaitHandler: GatewayRequestHandlers["agent.wait"] = async ({
  params,
  respond,
  context,
  client,
  isWebchatConnect,
}) => {
  if (!assertValidParams(params, validateAgentWaitParams, "agent.wait", respond)) {
    return;
  }
  const gatewayClient = client ?? null;
  const prepared = createAgentTurnService({ context, isWebchatConnect }).prepareWaitForTurn(params);
  const authorizeWait = async (
    run: Readonly<AgentJobSession> | undefined,
    accept: () => void = () => {},
  ) => {
    if (!gatewayClient?.authenticatedUserProfile || isGatewayAdmin(gatewayClient)) {
      accept();
      return true;
    }
    const cfg = context.getRuntimeConfig();
    if (operatorSessionCap(gatewayClient, cfg) !== "none") {
      accept();
      return true;
    }
    const requestedAgent = run?.sessionKey
      ? resolveRequestedSessionAgentId(cfg, run.sessionKey, run.agentId)
      : undefined;
    const facts =
      requestedAgent?.ok && run?.sessionKey
        ? await prepareSessionMutationFacts({
            cfg,
            sessionKey: run.sessionKey,
            agentId: requestedAgent.agentId,
            allowMissing: true,
          })
        : undefined;
    try {
      const currentConfig = context.getRuntimeConfig();
      const target = facts?.readCurrent(currentConfig).target;
      const visibilityFilter = createSessionListEntryFilter({
        client: gatewayClient,
        cfg: currentConfig,
      });
      if (
        !target ||
        run?.lifecycleGeneration !== getAgentRunLifecycleGeneration() ||
        (run?.sessionId !== undefined && target.entry.sessionId !== run.sessionId) ||
        visibilityFilter?.(target.storeKey, target.entry) === false
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent run was not found"),
        );
        return false;
      }
      accept();
      return true;
    } finally {
      facts?.release();
    }
  };
  const observation = await prepared.wait();
  await authorizeWait(observation.session, () => respond(true, observation.result));
};

export const agentHandlers: GatewayRequestHandlers = {
  agent: agentRunHandler,
  "agent.wait": agentWaitHandler,
};
