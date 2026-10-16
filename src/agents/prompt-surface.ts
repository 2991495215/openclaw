import { isOpenClawMainPromptSurface } from "../plugins/agent-prompt-surface-kind.js";
import type { AgentPromptSurfaceKind } from "../plugins/types.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../routing/session-key.js";

/** Builds fallback tool guidance when a runtime cannot render the structured tool list. */
export function buildOpenClawToolFallbackText(params: { surface: AgentPromptSurfaceKind }): string {
  if (isOpenClawMainPromptSurface(params.surface)) {
    return "The active runtime provides the available OpenClaw tools directly. Use only exposed tools; names are case-sensitive.";
  }

  return "No OpenClaw tool list is injected for this runtime prompt surface. Use only tools exposed directly by the active backend.";
}

export function resolveAgentPromptSurfaceForSessionKey(
  sessionKey?: string,
): AgentPromptSurfaceKind {
  if (sessionKey && isAcpSessionKey(sessionKey)) {
    return "acp_backend";
  }
  return sessionKey && isSubagentSessionKey(sessionKey) ? "subagent" : "openclaw_main";
}
