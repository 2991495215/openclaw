import type { SessionRunStatus } from "../../packages/gateway-protocol/src/schema/sessions-row.js";

export function isSessionRunStateActive(state: {
  hasActiveRun?: boolean;
  status?: SessionRunStatus;
}): boolean {
  if (state.status && state.status !== "queued" && state.status !== "running") {
    return false;
  }
  if (typeof state.hasActiveRun === "boolean") {
    return state.hasActiveRun;
  }
  return state.status === "queued" || state.status === "running";
}
