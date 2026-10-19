import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import type { RouteFacts } from "../turn/types.js";

/** Projects resolved routing into inbound context without copying routing policy fields. */
export function buildChannelInboundRouteFacts(
  route: Pick<ResolvedAgentRoute, "agentId" | "dmScope" | "accountId" | "sessionKey">,
  overrides?: Pick<RouteFacts, "dispatchSessionKey">,
): RouteFacts {
  return {
    agentId: route.agentId,
    dmScope: route.dmScope,
    accountId: route.accountId,
    routeSessionKey: route.sessionKey,
    ...overrides,
  };
}
