import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";
import type {
  CodexThreadForkParams,
  CodexThreadResumeParams,
  CodexThreadStartParams,
  CodexTurnStartParams,
} from "./protocol.js";

type TurnSettings = Pick<
  CodexTurnStartParams,
  | "additionalContext"
  | "cwd"
  | "runtimeWorkspaceRoots"
  | "model"
  | "approvalPolicy"
  | "approvalsReviewer"
  | "sandboxPolicy"
  | "serviceTier"
  | "effort"
  | "personality"
  | "environments"
  | "collaborationMode"
>;

type CodexThreadForkSettings = {
  thread: CodexThreadForkParams;
  turn?: TurnSettings;
};

const clients = defineCodexBuildState(
  "openclaw.codexClientForkSettings",
  () => new WeakMap<CodexAppServerClient, Map<string, CodexThreadForkSettings>>(),
)();

/** The physical client owner initializes and disposes these nonpersistent snapshots. */
export function initializeCodexClientForkSettings(client: CodexAppServerClient): void {
  clients.set(client, new Map());
}

export function forgetCodexClientForkSettings(
  client: CodexAppServerClient,
  threadId?: string,
): void {
  if (threadId === undefined) {
    clients.delete(client);
  } else {
    clients.get(client)?.delete(threadId);
  }
}

export function recordCodexThreadForkSettings(
  client: CodexAppServerClient,
  threadId: string,
  params: CodexThreadStartParams | CodexThreadResumeParams,
): void {
  const settings = clients.get(client);
  // Loaded native resumes ignore startup overrides; retain the original prompt carrier.
  if (!settings || settings.has(threadId)) {
    return;
  }
  const thread: CodexThreadForkParams = {
    threadId,
    model: params.model,
    modelProvider: params.modelProvider,
    cwd: params.cwd,
    runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
    approvalPolicy: params.approvalPolicy,
    approvalsReviewer: params.approvalsReviewer,
    sandbox: params.sandbox,
    permissions: typeof params.permissions === "string" ? params.permissions : undefined,
    serviceTier: params.serviceTier,
    config: params.config,
    developerInstructions: params.developerInstructions,
  };
  // Native history already owns base instructions and immutable dynamic declarations.
  settings.set(threadId, { thread });
}

export function recordCodexTurnForkSettings(
  client: CodexAppServerClient,
  params: CodexTurnStartParams,
): void {
  const settings = clients.get(client)?.get(params.threadId);
  if (settings) {
    settings.turn = {
      additionalContext: params.additionalContext,
      cwd: params.cwd,
      runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
      model: params.model,
      approvalPolicy: params.approvalPolicy,
      approvalsReviewer: params.approvalsReviewer,
      sandboxPolicy: params.sandboxPolicy,
      serviceTier: params.serviceTier,
      effort: params.effort,
      personality: params.personality,
      environments: params.environments,
      collaborationMode: params.collaborationMode,
    };
  }
}

export function requireCodexThreadForkSettings(
  client: CodexAppServerClient,
  threadId: string,
): CodexThreadForkSettings & { turn: TurnSettings } {
  const settings = clients.get(client)?.get(threadId);
  if (!settings?.turn) {
    throw new Error(
      "Cache-parity session fork requires a parent turn prepared by this OpenClaw runtime. Send a normal message first.",
    );
  }
  return { ...settings, turn: settings.turn };
}
