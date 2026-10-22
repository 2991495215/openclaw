import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../../../api/gateway.ts";
import { isRetryableGatewayReadError } from "../../../lib/gateway-errors.ts";
import { isGatewayMethodAdvertised } from "../../../lib/gateway-methods.ts";
import { createGatewayRetryOwner } from "../../../lib/gateway-retry.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { readWorkspaceFileText } from "./chat-session-workspace-file-content.ts";
import {
  getSessionWorkspace,
  isCurrentSessionWorkspace,
  sessionWorkspaceForHost,
  trackSessionCheckoutSidebar,
} from "./chat-session-workspace-state.ts";
import type { SessionWorkspaceHost } from "./chat-session-workspace-types.ts";
import type { SessionWorkspacePreview, SidebarContent } from "./chat-sidebar-content-types.ts";

export function resolveSessionWorkspaceDiff(
  state: SessionWorkspaceHost,
  openFile: (path: string) => Promise<SessionWorkspacePreview | undefined> | undefined,
): SidebarContent | null {
  const workspace = getSessionWorkspace(state);
  const client = state.client;
  if (isGatewayMethodAdvertised(state, "sessions.diff") !== true || !client) {
    return null;
  }
  if (workspace.diffContent) {
    return workspace.diffContent;
  }
  const sessionKey = state.sessionKey;
  const agentId = workspace.agentId;
  const canLoadFileText =
    isGatewayMethodAdvertised(state, "sessions.files.get") === true && Boolean(state.client);
  let uncommittedLoad: { promise: Promise<SessionsDiffResult>; pending: boolean } | undefined;
  let demands = 0;
  let inFlight = false;
  let pendingRead = true;
  let retired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopVisibility: (() => void) | undefined;
  const retry = createGatewayRetryOwner();
  const visible = () => document.visibilityState !== "hidden";
  const currentScope = () => content.canRead?.() && workspace.diffContent?.load === content.load;
  const retire = () => {
    retired = true;
    clearTimeout(timer);
    retry.cancel();
    stopVisibility?.();
    stopVisibility = undefined;
  };
  const refresh = async () => {
    if (!demands || inFlight || !visible() || !currentScope()) {
      return;
    }
    inFlight = true;
    retry.cancel();
    try {
      await content.load({ scope: "uncommitted" });
    } catch {
      // The retained loader records recovery once for all consumers of this request.
    } finally {
      inFlight = false;
    }
  };
  const sync = () => {
    clearTimeout(timer);
    if (!currentScope()) {
      retire();
    } else if (!demands || !visible()) {
      retry.pause();
    } else if (!retry.resume() && pendingRead) {
      void refresh();
    }
  };
  const content: Extract<SidebarContent, { kind: "session-diff" }> = {
    kind: "session-diff",
    // Checkout retirement replaces this identity; ordinary refreshes retain it.
    owner: workspace,
    canRead: () =>
      !retired &&
      state.connected &&
      state.client === client &&
      isCurrentSessionWorkspace(state, workspace),
    load: (scope, options) => {
      // Background readers share a request; explicit refresh revalidates native state.
      if (scope.scope === "uncommitted" && uncommittedLoad?.pending && !options?.refresh) {
        return uncommittedLoad.promise;
      }
      const request = client.request<SessionsDiffResult>("sessions.diff", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ...scope,
        poll: !options?.refresh,
      });
      if (scope.scope !== "uncommitted") {
        return request;
      }
      clearTimeout(timer);
      retry.cancel();
      const load = { promise: request, pending: true };
      load.promise = request
        .then((result) => {
          if (uncommittedLoad === load && currentScope()) {
            retry.reset();
            pendingRead = result.computing === true;
            if (demands && visible() && pendingRead) {
              timer = setTimeout(() => void refresh(), 500);
            }
            content.onResult?.({ owner: workspace, scope, result });
          }
          return result;
        })
        .catch((error: unknown) => {
          if (uncommittedLoad === load && currentScope()) {
            pendingRead = isRetryableGatewayReadError(error, "sessions.diff");
            if (pendingRead) {
              retry.schedule(
                () => void refresh(),
                error instanceof GatewayRequestError ? error.retryAfterMs : undefined,
              );
              if (!demands || !visible()) {
                retry.pause();
              }
            }
          }
          throw error;
        })
        .finally(() => {
          load.pending = false;
        });
      uncommittedLoad = load;
      return load.promise;
    },
    retireUncommitted: retire,
    requestUncommitted: () => {
      demands++;
      if (demands === 1) {
        stopVisibility = listen(document, "visibilitychange", sync);
        if (!inFlight && !retry.hasPending()) {
          pendingRead = true;
        }
        sync();
      }
      return () => {
        demands--;
        if (!demands) {
          stopVisibility?.();
          stopVisibility = undefined;
          sync();
        }
      };
    },
    onResult: ({ owner, scope, result }) => {
      const current = workspace.diffContent;
      if (
        owner !== workspace ||
        result.computing ||
        scope.scope !== "uncommitted" ||
        !isCurrentSessionWorkspace(state, workspace) ||
        current?.kind !== "session-diff" ||
        current.load !== content.load
      ) {
        return;
      }
      retry.reset();
      pendingRead = false;
      clearTimeout(timer);
      if (current.uncommitted !== result) {
        current.uncommitted = result;
        sessionWorkspaceForHost(state).publish();
      }
    },
    loadFileText: canLoadFileText
      ? async (path) => {
          try {
            const result = await state.sessions.getFile(sessionKey, path, {
              agentId,
            });
            return readWorkspaceFileText(result?.file);
          } catch {
            return null;
          }
        }
      : undefined,
    openFile,
  };
  trackSessionCheckoutSidebar(content);
  workspace.diffContent = content;
  return content;
}
