import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createChangeListeners } from "../../../../../src/shared/listeners.js";
import {
  scopedAgentParamsForSession,
  type SessionScopeHostWithKey,
} from "../../../lib/sessions/index.ts";
import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../../lib/sessions/session-key.ts";
import type {
  SessionWorkspaceArtifacts,
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";

export function resolvePaneAgent(state: SessionScopeHostWithKey): string {
  if (normalizeOptionalString(state.sessionKey)?.toLowerCase() !== "global") {
    return resolveAgentIdFromSessionKey(state.sessionKey);
  }
  return (
    scopedAgentParamsForSession(state, state.sessionKey).agentId ??
    normalizeAgentId(
      state.assistantAgentId ??
        state.agentsList?.defaultId ??
        state.agentsList?.agents?.[0]?.id ??
        "main",
    )
  );
}

export function createWorkspaceArtifacts(): SessionWorkspaceArtifacts {
  return { items: [], resolved: false, loaded: false, loading: false, error: null };
}

export function createWorkspaceTree() {
  return {
    expandedPaths: [""],
    searchOpen: false,
    sessionExpanded: true,
    treeVisible: true,
    treeScroll: 0,
    sessionScroll: 0,
  };
}

export function captureSessionWorkspaceNavigation(workspace: SessionWorkspaceState) {
  const tree = (workspace.tree ??= createWorkspaceTree());
  return {
    ...tree,
    expandedPaths: [...tree.expandedPaths],
    browserPath: workspace.browserPath,
    browserSearch: workspace.browserSearch,
    filter: workspace.filter,
  };
}

export function createSessionWorkspaceState(state: SessionWorkspaceHost): SessionWorkspaceState {
  return {
    tree: createWorkspaceTree(),
    directories: Object.create(null),
    artifacts: createWorkspaceArtifacts(),
    previews: [],
    activePreviewId: null,
    activeId: null,
    agentId: resolvePaneAgent(state),
    browserPath: "",
    browserSearch: "",
    filter: "all",
    browserSearchTimer: null,
    connectionEpoch: state.connectionEpoch,
    error: null,
    list: null,
    loading: false,
    pendingReload: false,
    sessionKey: state.sessionKey,
  };
}

type SessionWorkspaceOwner = {
  readonly state: SessionWorkspaceState | undefined;
  subscribe(listener: () => void): () => void;
  publish(): void;
};

type SessionWorkspaceSource = Pick<SessionWorkspaceHost, "sessionWorkspaceState">;
const workspaceOwners = new WeakMap<SessionWorkspaceSource, SessionWorkspaceOwner>();

/** Publishes workspace mutations without replacing the raw preview and editor identities. */
export function sessionWorkspaceForHost(host: SessionWorkspaceSource): SessionWorkspaceOwner {
  let owner = workspaceOwners.get(host);
  if (!owner) {
    const listeners = createChangeListeners();
    owner = {
      get state() {
        return host.sessionWorkspaceState;
      },
      subscribe: listeners.subscribe,
      publish: listeners.publish,
    };
    workspaceOwners.set(host, owner);
  }
  return owner;
}
