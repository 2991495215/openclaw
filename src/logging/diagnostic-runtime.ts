import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  peekDiagnosticSessionState,
  touchDiagnosticSessionState,
  type SessionRef,
  type SessionStateValue,
} from "./diagnostic-session-state.js";
import { createSubsystemLogger } from "./subsystem.js";

export const diagnosticLogger = createSubsystemLogger("diagnostic");
let lastActivityAt = 0;

export function markDiagnosticActivity(): void {
  lastActivityAt = Date.now();
}

export function getLastDiagnosticActivityAt(): number {
  return lastActivityAt;
}

export function resetDiagnosticActivityForTest(): void {
  lastActivityAt = 0;
}

type DiagnosticMessageQueueParams = SessionRef & {
  channel?: string;
  source: string;
};

/** Records queue activity while letting internal run owners distinguish steering from backlog. */
export function logMessageQueuedWithBacklogPolicy(
  params: DiagnosticMessageQueueParams,
  countsTowardBacklog: boolean,
): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const state = getDiagnosticSessionState(params);
  if (countsTowardBacklog) {
    state.queueDepth += 1;
  }
  state.lastActivity = Date.now();
  state.generation = (state.generation ?? 0) + 1;
  state.lastStuckWarnAgeMs = undefined;
  state.lastLongRunningWarnAgeMs = undefined;
  if (diagnosticLogger.isEnabled("debug")) {
    diagnosticLogger.debug(
      `message queued: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
        state.sessionKey ?? "unknown"
      } source=${params.source} queueDepth=${state.queueDepth} sessionState=${state.state}`,
    );
  }
  emitDiagnosticEvent({
    type: "message.queued",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    channel: params.channel,
    source: params.source,
    queueDepth: state.queueDepth,
  });
  markDiagnosticActivity();
}

export function logLaneEnqueue(lane: string, queueSize: number): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  diagnosticLogger.debug(`lane enqueue: lane=${lane} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.enqueue",
    lane,
    queueSize,
  });
  markDiagnosticActivity();
}

export function logLaneDequeue(lane: string, waitMs: number, queueSize: number): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  diagnosticLogger.debug(`lane dequeue: lane=${lane} waitMs=${waitMs} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.dequeue",
    lane,
    queueSize,
    waitMs,
  });
  markDiagnosticActivity();
}

export function logSessionStateChange(
  params: SessionRef & {
    state: SessionStateValue;
    reason?: string;
    /** Message lifecycle owns its queue count; controller retirement only projects idle. */
    consumeQueuedTurn?: boolean;
  },
) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  // Controller retirement observes existing state; message lifecycle owns its identity.
  const projectsIdle = params.state === "idle" && params.consumeQueuedTurn === false;
  const state = projectsIdle
    ? peekDiagnosticSessionState(params)
    : getDiagnosticSessionState(params);
  if (!state || (projectsIdle && state.state === "idle")) {
    return;
  }
  const prevState = state.state;
  state.state = params.state;
  touchDiagnosticSessionState(state);
  if (params.state === "processing" && prevState !== "processing") {
    state.activeQueuedTurn = state.queueDepth > 0;
  }
  if (params.state === "idle") {
    if (params.consumeQueuedTurn !== false) {
      state.queueDepth = Math.max(0, state.queueDepth - 1);
    }
    state.activeQueuedTurn = false;
  }
  emitDiagnosticEvent({
    type: "session.state",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    prevState,
    state: params.state,
    reason: params.reason,
    queueDepth: state.queueDepth,
  });
  markDiagnosticActivity();
}
