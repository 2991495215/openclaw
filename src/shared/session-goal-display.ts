import type { SessionGoal } from "../config/sessions/types.js";

export const SESSION_GOAL_STATUS_FACTS = {
  active: { label: "Pursuing goal", stopField: undefined, resumeHint: false },
  paused: { label: "Goal paused", stopField: "pausedAt", resumeHint: true },
  blocked: { label: "Goal blocked", stopField: "blockedAt", resumeHint: true },
  usage_limited: { label: "Goal hit usage limits", stopField: "usageLimitedAt", resumeHint: true },
  budget_limited: { label: "Goal unmet", stopField: "budgetLimitedAt", resumeHint: false },
  complete: { label: "Goal achieved", stopField: "completedAt", resumeHint: false },
} as const satisfies Record<
  SessionGoal["status"],
  { label: string; stopField: keyof SessionGoal | undefined; resumeHint: boolean }
>;

function formatGoalTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    const rounded = value >= 10_000 ? Math.round(value / 1000) : Math.round(value / 100) / 10;
    if (rounded >= 1000) {
      return "1m";
    }
    return `${rounded}k`;
  }
  const rounded =
    value >= 10_000_000 ? Math.round(value / 1_000_000) : Math.round(value / 100_000) / 10;
  return `${rounded}m`;
}

export function formatGoalUsage(goal: SessionGoal): string | null {
  if (typeof goal.tokenBudget === "number" && Number.isFinite(goal.tokenBudget)) {
    return `${formatGoalTokenCount(goal.tokensUsed)}/${formatGoalTokenCount(goal.tokenBudget)}`;
  }
  if (goal.tokensUsed > 0) {
    return `${formatGoalTokenCount(goal.tokensUsed)} used`;
  }
  return null;
}

export function formatGoalStatusLabel(status: SessionGoal["status"]): string {
  return SESSION_GOAL_STATUS_FACTS[status].label;
}

export function formatGoalSummary(goal: SessionGoal): string {
  const usage = formatGoalUsage(goal);
  const status = formatGoalStatusLabel(goal.status);
  return usage ? `${status} (${usage})` : status;
}

/** Wall-clock time spent on the goal; frozen at the status timestamp once not active. */
export function goalElapsedMs(goal: SessionGoal, now: number): number {
  const stopField = SESSION_GOAL_STATUS_FACTS[goal.status].stopField;
  const stoppedAt = stopField ? (goal[stopField] ?? goal.updatedAt) : now;
  return Math.max(0, stoppedAt - goal.createdAt);
}

export function formatGoalElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${hours}h ${minutes}m ${seconds}s`;
}

export function formatGoalDetail(goal: SessionGoal): string {
  const note = goal.lastStatusNote ? ` - ${goal.lastStatusNote}` : "";
  return `${formatGoalSummary(goal)}: ${goal.objective}${note}`;
}
