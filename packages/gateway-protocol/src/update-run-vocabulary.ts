export const UPDATE_RUN_DRIVER_LIMIT = 8;

export const UPDATE_INSTALLATION_METHODS = [
  "git-checkout",
  "npm-global",
  "pnpm-global",
  "bun-global",
  "managed-service",
  "ocm",
] as const;

export const UPDATE_ROLLBACK_STATUSES = [
  "not-needed",
  "not-attempted",
  "succeeded",
  "failed",
] as const;
export const UPDATE_PLUGIN_RESULT_STATUSES = ["ok", "warning", "skipped", "error"] as const;

export const IMMUTABLE_ACTIVATION_PHASES = [
  "prepared",
  "draining",
  "stopping",
  "stopped",
  "publishing",
  "starting",
  "verifying",
  "rollback-stopping",
  "rollback-publishing",
  "rollback-starting",
  "rolled-back",
  "recovery-required",
] as const;

export const UPDATE_RUN_PHASES = [
  "requested",
  "staging",
  "validating",
  "repairing",
  "activating",
  "restarting",
  "verifying",
  "finished",
] as const;
export const UPDATE_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "rolled-back",
  "skipped",
] as const;
export const UPDATE_RUN_TRIGGERS = [
  "chat",
  "control-ui",
  "cli",
  "campaign",
  "mac-app",
  "api",
] as const;
export const UPDATE_RUN_STEP_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
] as const;

export const UPDATE_NPM_ERROR_CODES = [
  "ETARGET",
  "E404",
  "EINTEGRITY",
  "EACCES",
  "ENOTEMPTY",
  "ENOSPC",
  "ECONNRESET",
  "ETIMEDOUT",
  "EBUSY",
  "unknown",
] as const;
