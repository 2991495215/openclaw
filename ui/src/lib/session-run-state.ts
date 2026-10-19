import type { SessionRunStatus } from "@openclaw/gateway-protocol";

export { isSessionRunStateActive } from "../../../src/shared/session-run-state.js";

export const TERMINAL_RUN_OUTCOMES: Partial<
  Record<SessionRunStatus, "completed" | "failed" | "stopped">
> = {
  done: "completed",
  failed: "failed",
  killed: "stopped",
  timeout: "failed",
};

/** Chat-only presentation: settlement still owns an active, abortable run. */
export function isSessionRunVisuallyActive(active: boolean, phase?: string): boolean {
  return active && phase !== "finishing" && phase !== "answer";
}
