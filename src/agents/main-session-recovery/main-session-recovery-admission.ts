import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";

/** Process-wide identity for recovery work admitted by the normal Gateway handler. */
export const MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER = Symbol.for(
  "openclaw.mainSessionRecoveryWorkAdmission",
);

export type MainSessionRecoveryContinuation = {
  shouldContinue: () => boolean;
};

/** Startup prepares durable recovery; the normal handler owns execution admission. */
export async function runWithMainSessionRecoveryContinuation<T>(params: {
  continuation?: MainSessionRecoveryContinuation;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  signal?: AbortSignal;
  isCurrent: () => boolean;
  run: (continuation: MainSessionRecoveryContinuation) => Promise<T>;
}): Promise<T | undefined> {
  const lifecycleGeneration = params.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  const shouldContinue = () =>
    params.shouldContinue?.() !== false &&
    lifecycleGeneration === getAgentEventLifecycleGeneration();
  if (!shouldContinue() || !params.isCurrent()) {
    return undefined;
  }
  if (params.continuation) {
    return params.continuation.shouldContinue() ? await params.run(params.continuation) : undefined;
  }

  // Backlog waits precede session ownership, retry charges and Gateway queue deadlines.
  // Exact retries must remain interruptible by reset without holding a session admission.
  await enqueueCommandInLane(CommandLane.Background, async () => {}, {
    abortSignal: params.signal
      ? AbortSignal.any([params.signal, getGatewayRestartDrainSignal()])
      : getGatewayRestartDrainSignal(),
  });
  if (!shouldContinue() || !params.isCurrent()) {
    return undefined;
  }

  return await params.run({ shouldContinue });
}
