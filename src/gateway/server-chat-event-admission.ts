import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agents/agent-run-terminal-outcome.js";
import { inspectMainSessionRecoveryLifecycleEvent } from "../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  getAgentEventLifecycleGeneration,
  type AgentEventPayload,
  type AgentEventRuntimePayload,
} from "../infra/agent-events.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import type { ChatRunEntry } from "./server-chat-state.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

/** Orders a handler's accepted events around fresh recovery reads, independently of display enrichment. */
export function createAgentEventAdmission({
  handleEvent,
  resolveEventSession,
  isCurrent,
  dispose,
}: {
  handleEvent: (event: AgentEventPayload, recovery?: { suppress: boolean }) => void;
  resolveEventSession: (event: AgentEventRuntimePayload) => {
    chatLink?: ChatRunEntry;
    sessionAgentId?: string;
    eventSessionKey?: string;
    sessionKey?: string;
  };
  isCurrent: (event: AgentEventRuntimePayload) => boolean;
  dispose: () => void;
}) {
  const resolveRestartRecoveryLifecycleState = async (
    sessionKey: string,
    agentId: string | undefined,
    event: AgentEventPayload,
  ): Promise<{ suppress: boolean }> => {
    const cfg = getRuntimeConfig();
    const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg,
      key: sessionKey,
      ...(agentId ? { agentId } : {}),
    }).catch(() => undefined);
    return {
      suppress: inspectMainSessionRecoveryLifecycleEvent({
        currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
        entry: loaded?.entry,
        event,
      }).suppress,
    };
  };

  const pendingEvents = new Map<string, Promise<void>>();
  let closed = false;
  const acceptEvent = (evt: AgentEventRuntimePayload): void | Promise<void> => {
    if (closed) {
      return;
    }
    if (!isCurrent(evt)) {
      return;
    }
    const phase = evt.stream === "lifecycle" ? evt.data.phase : undefined;
    const terminal =
      phase === "end" || phase === "error"
        ? buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase, data: evt.data })
        : undefined;
    const needsRecoveryRead =
      Boolean(evt.runId.trim() && evt.lifecycleGeneration?.trim()) &&
      (phase === "start" ||
        (terminal?.reason === "cancelled" && terminal.stopReason === "restart"));
    const source = resolveEventSession(evt);
    const sessionKey = source.eventSessionKey ?? source.sessionKey;
    const agentId = evt.agentId ?? source.sessionAgentId;
    const previous = pendingEvents.get(evt.runId);
    if (!(needsRecoveryRead && sessionKey) && !previous) {
      return handleEvent(evt);
    }
    const consume = async () => {
      // Read once after predecessors settle; display suppression uses the current store.
      const recovery =
        needsRecoveryRead && sessionKey
          ? await resolveRestartRecoveryLifecycleState(sessionKey, agentId, evt)
          : undefined;
      const current = resolveEventSession(evt);
      if (
        current.chatLink !== source.chatLink ||
        (current.eventSessionKey ?? current.sessionKey) !== sessionKey ||
        (evt.agentId ?? current.sessionAgentId) !== agentId
      ) {
        return;
      }
      handleEvent(evt, recovery);
    };
    const pending = previous ? previous.then(consume, consume) : consume();
    pendingEvents.set(evt.runId, pending);
    const release = () => {
      if (pendingEvents.get(evt.runId) === pending) {
        pendingEvents.delete(evt.runId);
      }
    };
    void pending.then(release, release);
    return pending;
  };
  return Object.assign(
    (event: AgentEventPayload) => runOutsideAsyncWorkScope(() => acceptEvent(event)),
    {
      dispose: async () => {
        closed = true;
        dispose();
        await Promise.allSettled(pendingEvents.values());
        dispose();
      },
    },
  );
}
