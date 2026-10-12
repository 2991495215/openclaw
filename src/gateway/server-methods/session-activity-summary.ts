import {
  ErrorCodes,
  errorShape,
  validateSessionsActivitySummaryEnsureParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import type { PreparedSessionMutationFacts } from "../session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  type SessionFactsRead,
} from "../session-sharing-preparation.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionSharingTarget,
  prepareSessionSharing,
} from "../session-sharing.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export const sessionActivitySummaryHandlers: GatewayRequestHandlers = {
  "sessions.activitySummary.ensure": defineValidatedGatewayHandler(
    "sessions.activitySummary.ensure",
    validateSessionsActivitySummaryEnsureParams,
    async ({ params, client, context, respond }) => {
      const service = context.sessionActivitySummaries;
      if (!service) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Activity recaps are unavailable."),
        );
        return;
      }
      const reads: Array<{
        key: string;
        agentId: string;
        facts?: SessionFactsRead<PreparedSessionMutationFacts>;
      }> = [];
      try {
        const sourceConfig = context.getRuntimeConfig();
        for (const requested of params.sessions) {
          const agent = resolveRequestedSessionAgentId(
            sourceConfig,
            requested.key,
            requested.agentId,
          );
          if (!agent.ok) {
            respond(false, undefined, agent.error);
            return;
          }
          const facts = isIncognitoSessionKey(requested.key)
            ? undefined
            : await prepareSessionMutationFacts({
                cfg: sourceConfig,
                sessionKey: requested.key,
                agentId: agent.agentId,
                allowMissing: true,
              });
          reads.push({ key: requested.key, agentId: agent.agentId, facts });
        }
        const cfg = context.getRuntimeConfig();
        const sharing = prepareSessionSharing({ client, cfg });
        const targets = [];
        // Consume current facts for the whole batch before enqueueing any model work.
        for (const read of reads) {
          if (!read.facts) {
            const error = authorizeIncognitoSessionTarget({
              client,
              sessionKey: read.key,
              target: null,
            });
            if (error) {
              respond(false, undefined, error);
              return;
            }
            targets.push({ key: read.key, agentId: read.agentId, unavailable: true });
            continue;
          }
          const target = read.facts.readCurrent(cfg).target;
          if (
            !target ||
            (hasOperatorBoundary(client, cfg) &&
              sharing.entryFilter?.(target.canonicalKey, target.entry) === false)
          ) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, "Session is unavailable."),
            );
            return;
          }
          const error =
            authorizeIncognitoSessionTarget({ client, sessionKey: read.key, target }) ??
            authorizeSessionSharingTarget({ cfg, client, target });
          if (error) {
            respond(false, undefined, error);
            return;
          }
          targets.push({
            key: target.canonicalKey,
            agentId: target.agentId,
            sessionId: target.entry.sessionId,
            facts: read.facts,
          });
        }
        const sessions = await Promise.all(
          targets.map(async (target) => ({
            key: target.key,
            agentId: target.agentId,
            activitySummary: {
              ...(target.unavailable
                ? { state: "unavailable" as const }
                : await service.ensure({
                    key: target.key,
                    agentId: target.agentId,
                  })),
              canEnsure: true,
            },
          })),
        );
        const currentCfg = context.getRuntimeConfig();
        const currentSharing = prepareSessionSharing({ client, cfg: currentCfg });
        for (const requested of targets) {
          if (requested.unavailable) {
            continue;
          }
          const target = requested.facts?.readCurrent(currentCfg).target;
          const error =
            target && target.entry.sessionId === requested.sessionId
              ? authorizeSessionSharingTarget({ cfg: currentCfg, client, target })
              : errorShape(ErrorCodes.INVALID_REQUEST, "Session is unavailable.");
          if (
            error ||
            (target &&
              hasOperatorBoundary(client, currentCfg) &&
              currentSharing.entryFilter?.(target.canonicalKey, target.entry) === false)
          ) {
            respond(
              false,
              undefined,
              error ?? errorShape(ErrorCodes.INVALID_REQUEST, "Session is unavailable."),
            );
            return;
          }
        }
        respond(true, { sessions });
      } finally {
        for (const read of reads) {
          read.facts?.release();
        }
      }
    },
  ),
};
