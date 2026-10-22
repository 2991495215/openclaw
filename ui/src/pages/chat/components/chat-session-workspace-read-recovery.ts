import { GatewayRequestError } from "../../../api/gateway.ts";
import { isRetryableGatewayReadError } from "../../../lib/gateway-errors.ts";
import { createGatewayRetryOwner } from "../../../lib/gateway-retry.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";

type RecoveryContracts = {
  isCurrent: (state: SessionWorkspaceHost, workspace: SessionWorkspaceState) => boolean;
  artifactsWanted: (state: SessionWorkspaceHost, role: "all" | "assistant") => boolean;
  refresh: (state: SessionWorkspaceHost, workspace: SessionWorkspaceState) => void;
};
type ArtifactRole = "all" | "assistant";

/** Per-workspace scheduling only; request admission and read data stay with the workspace owner. */
export function createWorkspaceReadRecoveryRegistry(contracts: RecoveryContracts) {
  const recoveries = new WeakMap<
    SessionWorkspaceState,
    ReturnType<typeof createWorkspaceReadRecovery>
  >();
  return {
    requestFiles: requestWorkspaceFiles,
    clearFiles: clearWorkspaceFileRequests,
    for(state: SessionWorkspaceHost, workspace: SessionWorkspaceState) {
      let recovery = recoveries.get(workspace);
      if (!recovery) {
        recovery = createWorkspaceReadRecovery(state, workspace, contracts);
        recoveries.set(workspace, recovery);
      }
      recovery.sync();
      return recovery;
    },
    dispose(workspace: SessionWorkspaceState) {
      recoveries.get(workspace)?.dispose();
    },
  };
}

function createWorkspaceReadRecovery(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  contracts: RecoveryContracts,
) {
  const reads = new Map<
    string,
    {
      retry: ReturnType<typeof createGatewayRetryOwner>;
      current: () => boolean;
      enabled: () => boolean;
    }
  >();
  let fileDemands = 0;
  let stopVisibility: (() => void) | undefined;
  const filesWanted = () => fileDemands > 0;
  const artifactsWanted = (role: ArtifactRole) =>
    contracts.artifactsWanted(state, role) || (role === "all" && filesWanted());
  const wanted = () => filesWanted() || artifactsWanted("all") || artifactsWanted("assistant");
  const retire = (key: string) => {
    reads.get(key)?.retry.reset();
    reads.delete(key);
  };
  const currentRead = (key: string) => {
    const read = reads.get(key);
    if (read && !read.current()) {
      retire(key);
      return undefined;
    }
    return read;
  };
  const pending = (key: string) => currentRead(key)?.retry.hasPending() ?? false;
  const dispose = () => {
    for (const key of reads.keys()) {
      retire(key);
    }
    stopVisibility?.();
    stopVisibility = undefined;
  };
  const sync = () => {
    if (!contracts.isCurrent(state, workspace) || !state.connected) {
      dispose();
      return;
    }
    if (wanted()) {
      stopVisibility ??= listen(document, "visibilitychange", sync);
    } else {
      stopVisibility?.();
      stopVisibility = undefined;
    }
    for (const key of reads.keys()) {
      const read = currentRead(key);
      if (!read) {
        continue;
      }
      if (wanted() && document.visibilityState !== "hidden" && read.enabled()) {
        read.retry.resume();
      } else {
        read.retry.pause();
      }
    }
  };
  return {
    filesWanted,
    artifactsWanted,
    sync,
    dispose,
    pending,
    begin(key: string) {
      currentRead(key)?.retry.cancel();
    },
    success: retire,
    failed(
      key: string,
      error: unknown,
      method: string,
      current: () => boolean,
      enabled: () => boolean,
      read: () => void,
    ) {
      if (!isRetryableGatewayReadError(error, method)) {
        retire(key);
        return;
      }
      const recovery = currentRead(key) ?? { retry: createGatewayRetryOwner(), current, enabled };
      recovery.current = current;
      recovery.enabled = enabled;
      reads.set(key, recovery);
      recovery.retry.schedule(
        () => {
          if (
            contracts.isCurrent(state, workspace) &&
            state.connected &&
            current() &&
            document.visibilityState !== "hidden" &&
            enabled()
          ) {
            read();
          }
        },
        error instanceof GatewayRequestError ? error.retryAfterMs : undefined,
      );
      sync();
    },
    retainFiles(this: void) {
      fileDemands++;
      sync();
      if (workspace.error && !workspace.loading && !pending("files")) {
        contracts.refresh(state, workspace);
      }
      return () => {
        fileDemands--;
        sync();
      };
    },
  };
}

type FileListing = Awaited<ReturnType<SessionWorkspaceHost["sessions"]["listFiles"]>>;
const fileLoads = new WeakMap<SessionWorkspaceState, Map<string, Promise<FileListing>>>();

function clearWorkspaceFileRequests(workspace: SessionWorkspaceState) {
  fileLoads.delete(workspace);
}

function requestWorkspaceFiles(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  path: string,
  search = "",
) {
  let requests = fileLoads.get(workspace);
  if (!requests) {
    requests = new Map();
    fileLoads.set(workspace, requests);
  }
  const key = JSON.stringify([path, search]);
  const pending = requests.get(key);
  if (pending) {
    return pending;
  }
  const request = state.sessions.listFiles(workspace.sessionKey, {
    path,
    search,
    agentId: workspace.agentId,
  });
  requests.set(key, request);
  void request.finally(() => requests.delete(key)).catch(() => {});
  return request;
}
