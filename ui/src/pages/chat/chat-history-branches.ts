import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import type { SessionBranch } from "../../api/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isRetryableGatewayReadError } from "../../lib/gateway-errors.ts";
import { createGatewayRetryOwner } from "../../lib/gateway-retry.ts";
import { scopedAgentParamsForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { chatHistoryRequests, type ChatBranchesQueryState } from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";

const pendingBranchLoads = new WeakMap<
  ChatState,
  { matches: () => boolean; promise: Promise<void> }
>();

export function retireChatBranchRequests(state: ChatState): void {
  const requests = chatHistoryRequests(state);
  requests.branchVersion += 1;
  requests.branchRetry?.reset();
  requests.branchRetry = undefined;
  // Parking cancels work, but a settled receipt remains valid for the same scope.
  if (requests.branchQuery?.query.status === "loading") {
    requests.branchQuery = undefined;
  }
  pendingBranchLoads.delete(state);
}

/** Parking keeps an admitted failure's server deadline; in-flight reads still retire. */
export function pauseChatBranchRequests(state: ChatState): void {
  const requests = chatHistoryRequests(state);
  if (requests.branchRetry && requests.branchQuery?.query.status === "error") {
    requests.branchRetry.pause();
  } else {
    retireChatBranchRequests(state);
  }
}

/** Returns whether failed-read recovery owns the next request. */
export function syncChatBranchRetryPresentation(state: ChatState): boolean {
  const requests = chatHistoryRequests(state);
  if (state.chatMetadataIsPresented?.() === false) {
    requests.branchRetry?.pause();
    return Boolean(requests.branchRetry && requests.branchQuery?.query.status === "error");
  }
  return requests.branchRetry?.resume() ?? false;
}

export function invalidateChatBranches(state: ChatState): void {
  retireChatBranchRequests(state);
  chatHistoryRequests(state).branchQuery = undefined;
  // Keep the displayed menu while the next history refresh reconciles saved tips.
  state.chatBranchesConnectionEpoch = null;
}

/** Branches for the current pane; equivalence covers alias-canonicalization windows (#124020 class). */
export function displayedChatSessionBranches(
  state: Pick<ChatState, "chatBranches" | "chatBranchesSessionKey" | "sessionKey">,
): SessionBranch[] {
  return areUiSessionKeysEquivalent(state.chatBranchesSessionKey, state.sessionKey)
    ? (state.chatBranches ?? [])
    : [];
}

/** Read through the native request receipt; retained rows alone do not prove a successful query. */
export function getChatBranchesQueryState(state: ChatState): ChatBranchesQueryState {
  const receipt = chatHistoryRequests(state).branchQuery;
  return receipt?.isCurrent() ? receipt.query : { status: "idle" };
}

export function canLoadChatBranches(state: ChatState): boolean {
  return Boolean(state.sessions?.listBranches && state.client && state.connected);
}

export async function loadChatBranches(state: ChatState): Promise<void> {
  const { sessions, client, sessionKey, connectionEpoch } = state;
  const listBranches = sessions?.listBranches;
  if (!listBranches || !canLoadChatBranches(state)) {
    return;
  }
  const pending = pendingBranchLoads.get(state);
  if (pending?.matches()) {
    return pending.promise;
  }
  const requests = chatHistoryRequests(state);
  if (!requests.branchQuery?.isCurrent()) {
    requests.branchRetry?.reset();
    requests.branchRetry = undefined;
  }
  requests.branchRetry?.cancel();
  const version = ++requests.branchVersion;
  const agentParams = scopedAgentParamsForSession(state, sessionKey);
  const isScopeCurrent = () =>
    state.client === client &&
    state.connected &&
    state.connectionEpoch === connectionEpoch &&
    visibleSessionMatches(state, sessionKey, agentParams.agentId);
  const isCurrent = () => requests.branchVersion === version && isScopeCurrent();
  requests.branchQuery = { isCurrent, query: { status: "loading" } };
  const promise = (async () => {
    try {
      const branches = await listBranches.call(sessions, sessionKey, agentParams);
      if (isCurrent()) {
        requests.branchRetry?.reset();
        requests.branchRetry = undefined;
        if (JSON.stringify(state.chatBranches ?? []) !== JSON.stringify(branches)) {
          state.chatBranches = branches;
        }
        state.chatBranchesSessionKey = sessionKey;
        state.chatBranchesConnectionEpoch = connectionEpoch;
        requests.branchQuery = { isCurrent: isScopeCurrent, query: { status: "ready" } };
      }
    } catch (error) {
      // Leave the success receipt unset so the next history load retries transient failures.
      if (isCurrent()) {
        requests.branchQuery = {
          isCurrent: isScopeCurrent,
          query: {
            status: "error",
            message: formatUiError(error),
            ...(isRetryableGatewayReadError(error, "sessions.branches.list")
              ? { retryable: true }
              : {}),
          },
        };
        if (isRetryableGatewayReadError(error, "sessions.branches.list")) {
          const retry = (requests.branchRetry ??= createGatewayRetryOwner());
          retry.schedule(
            () => {
              if (isCurrent() && state.chatMetadataIsPresented?.() !== false) {
                void loadChatBranches(state);
              }
            },
            error instanceof GatewayProtocolRequestError ? (error.retryAfterMs ?? 0) : 0,
          );
          syncChatBranchRetryPresentation(state);
        } else {
          requests.branchRetry?.reset();
          requests.branchRetry = undefined;
        }
      }
    }
  })().finally(() => {
    if (requests.branchVersion === version) {
      pendingBranchLoads.delete(state);
    }
  });
  pendingBranchLoads.set(state, {
    matches: () =>
      isCurrent() &&
      state.sessionKey === sessionKey &&
      scopedAgentParamsForSession(state, sessionKey).agentId === agentParams.agentId,
    promise,
  });
  return promise;
}
