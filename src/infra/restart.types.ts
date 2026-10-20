// Outcome of a platform-specific supervisor restart.
export type RestartAttempt = {
  ok: boolean;
  method: "launchctl" | "systemd" | "schtasks" | "supervisor";
  detail?: string;
};
