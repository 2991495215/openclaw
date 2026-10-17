export type BootstrapMode = "full" | "limited" | "none";
export type BootstrapContextRunKind = "default" | "heartbeat" | "cron";

export function isHeartbeatLifecycleRunKind(runKind: BootstrapContextRunKind | undefined): boolean {
  return runKind === "heartbeat";
}

export function resolveBootstrapMode(params: {
  bootstrapPending: boolean;
  runKind?: BootstrapContextRunKind;
  isInteractiveUserFacing: boolean;
  isPrimaryRun: boolean;
  isCanonicalWorkspace: boolean;
  hasBootstrapFileAccess: boolean;
}): BootstrapMode {
  if (!params.bootstrapPending) {
    return "none";
  }
  if (isHeartbeatLifecycleRunKind(params.runKind) || params.runKind === "cron") {
    // Background maintenance turns should not consume or mutate bootstrap state.
    return "none";
  }
  if (!params.isPrimaryRun || !params.isInteractiveUserFacing) {
    return "none";
  }
  return params.hasBootstrapFileAccess && params.isCanonicalWorkspace ? "full" : "limited";
}
