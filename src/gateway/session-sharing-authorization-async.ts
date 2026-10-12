import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { extractErrorCode, readErrorCause } from "../infra/errors.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  prepareSessionMutationAuthorizationRequest,
  sessionMutationTargetChanged,
} from "./session-sharing-authorization.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
  type SessionFactsRead,
} from "./session-sharing-preparation.js";
import { prepareSessionSharingProfiles } from "./session-sharing-read.js";
import {
  resolveChatSendAuthorizationParams,
  resolveSessionMutationTargets,
  resolveTalkSessionTargetInput,
} from "./session-sharing-target-input.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";

/** Read participation in the worker while retaining its owner through authorization. */
export async function resolveSessionMutationAuthorizationAsync(
  request: Parameters<typeof resolveSessionMutationAuthorization>[0] & {
    assertInvocationCurrent?: () => void;
  },
) {
  let params = request;
  params.assertInvocationCurrent?.();
  if (params.method === "chat.send") {
    const normalized = resolveChatSendAuthorizationParams(
      params.context.getRuntimeConfig(),
      params.requestParams,
    );
    if (!normalized.ok) {
      return { error: normalized.error };
    }
    params = { ...params, requestParams: normalized.value };
  }
  const preparation = prepareSessionMutationAuthorizationRequest(params);
  if (!preparation.ok) {
    return { error: preparation.error };
  }
  if (preparation.bypassTargetAuthorization) {
    return resolveSessionMutationAuthorization(params);
  }
  const cfg = params.context.getRuntimeConfig();
  const talkInput = resolveTalkSessionTargetInput(
    params.method,
    params.requestParams,
    params.client?.connId,
  );
  const preparedTalkSessionTarget =
    talkInput?.kind === "request"
      ? await prepareTalkSessionTarget(cfg, talkInput.sessionKey)
      : talkInput?.target;
  params.assertInvocationCurrent?.();
  const mutationTargets = preparedTalkSessionTarget
    ? [
        {
          sessionKey: preparedTalkSessionTarget.canonicalKey,
          agentId: preparedTalkSessionTarget.agentId,
        },
      ]
    : (resolveSessionMutationTargets({
        method: params.method,
        requestParams: params.requestParams,
        context: params.context,
      }) ?? []);
  const reads = new Map<string, SessionFactsRead<PreparedSessionMutationFacts>>();
  const identity = (target: { sessionKey: string; agentId?: string }, current = cfg) => {
    const selected = resolveSessionStoreIdentity({ cfg: current, ...target });
    return JSON.stringify([selected.agentId, selected.canonicalKey]);
  };
  let active = true;
  const release = () => {
    active = false;
    for (const read of reads.values()) {
      read.release();
    }
    reads.clear();
  };
  try {
    const preparedProfiles =
      params.method === "chat.send"
        ? await prepareSessionSharingProfiles(params.client)
        : undefined;
    params.assertInvocationCurrent?.();
    for (const target of mutationTargets) {
      const agent = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
      if (!agent.ok) {
        release();
        return { error: agent.error };
      }
      const key = identity(target);
      if (!reads.has(key)) {
        reads.set(
          key,
          await prepareSessionMutationFacts({
            cfg,
            ...target,
            agentId: agent.agentId,
            allowMissing: true,
          }),
        );
        params.assertInvocationCurrent?.();
      }
    }
    const result = resolveSessionMutationAuthorization({
      ...params,
      preparedTalkSessionTarget,
      preparedProfiles,
      preparedTargetRead: (target, current) => {
        params.assertInvocationCurrent?.();
        preparedProfiles?.readCurrent();
        if (!active) {
          throw new Error("Session authorization has been released");
        }
        const read = reads.get(identity(target, current));
        if (!read) {
          return undefined;
        }
        try {
          const facts = read.readCurrent(current);
          return {
            target: facts.target,
            storageTarget: read.storageTarget,
            members: [...facts.membership],
          };
        } catch (error) {
          if (error instanceof SessionMutationFactsUnavailableError) {
            throw sessionMutationTargetChanged(params.method, target.sessionKey);
          }
          throw error;
        }
      },
    });
    if (!result.authorization || result.error) {
      release();
      return result;
    }
    const previousRecordCreated = result.authorization.recordCreatedSession;
    result.authorization.recordCreatedSession = (created) => {
      previousRecordCreated?.(created);
      reads.get(identity(created))?.recordCreated?.(created);
    };
    const previousRelease = result.authorization.release;
    result.authorization.release = () => {
      previousRelease?.();
      release();
    };
    return result;
  } catch (error) {
    release();
    const cause =
      error instanceof SessionMutationFactsUnavailableError ? readErrorCause(error) : error;
    if (extractErrorCode(cause) === "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED") {
      return {
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          cause instanceof Error ? cause.message : String(cause),
        ),
      };
    }
    throw error;
  }
}
