import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultWorkingResponse,
} from "../../../talk/agent-consult-tool.js";
import { buildRealtimeVoiceAgentCancelProviderResult } from "../../../talk/agent-run-control-shared.js";
import type { RealtimeVoiceAgentControlResult } from "../../../talk/agent-run-control.js";
import { readSpeakableRealtimeVoiceToolResult } from "../../../talk/consult-question.js";
import type { RealtimeVoiceForcedConsultHandle } from "../../../talk/forced-consult-coordinator.js";
import type { RealtimeVoiceToolResultOptions } from "../../../talk/provider-types.js";
import {
  broadcastToolResultToOwner,
  clearRelayAgentToolCall,
  completeAfterToolResultSubmissions,
  submitFinalProviderToolResult,
  suppressedToolResultOptions,
  trackToolResultCompletion,
} from "./provider-results.js";
import {
  broadcastToOwner,
  ensureRelayTurn,
  noFallbackRelayOutputFlush,
  relaySessions,
  resolveRelayProviderToolCallId,
  type ForcedTerminalProviderResult,
  type RelayAgentControlProviderSubmission,
  type RelaySession,
} from "./state.js";

const FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const FORCED_CONSULT_RESULT_MAX_CHARS = 1_800;

const FORCED_CONSULT_CHECKING_PROMPT = [
  "Briefly tell the person that you are checking with OpenClaw.",
  "Do not answer the request yet. Wait for the OpenClaw result before giving the actual answer.",
].join(" ");

function buildForcedConsultSpeechPrompt(text: string): string {
  return [
    "OpenClaw finished checking. Speak this result naturally and concisely.",
    "Do not mention tool calls, JSON, or internal routing.",
    "",
    text,
  ].join("\n");
}

export function buildAlreadyDeliveredToolResult(): Record<string, string> {
  return {
    status: "already_delivered",
    message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
  };
}

function completeForcedTerminalProviderResult(
  session: RelaySession,
  callId: string,
  terminal: ForcedTerminalProviderResult,
  submission: void | Promise<void>,
  onAccepted: () => void,
): void | Promise<void> {
  const clearTerminal = () => {
    if (session.forcedTerminalProviderResults.get(callId) === terminal) {
      session.forcedTerminalProviderResults.delete(callId);
    }
  };
  const completion = completeAfterToolResultSubmissions(session, [submission], () => {
    if (session.forcedTerminalProviderResults.get(callId) !== terminal) {
      return;
    }
    clearTerminal();
    onAccepted();
  });
  return trackToolResultCompletion(
    session.pendingFinalToolResults,
    callId,
    completion?.finally(clearTerminal),
  );
}

export function submitRelayAgentControlProviderResults(
  session: RelaySession,
  result: RealtimeVoiceAgentControlResult,
  turnId: string,
): RelayAgentControlProviderSubmission | undefined {
  if (result.mode !== "cancel" || !result.ok || !result.providerResult) {
    return undefined;
  }
  const providerResult = result.providerResult;
  const callIds = [...session.activeAgentToolCalls.keys()];
  const activeCallIds = callIds.filter((callId) => !session.pendingFinalToolResults.has(callId));
  const submissions: Array<void | Promise<void>> = callIds
    .map((callId) => session.pendingFinalToolResults.get(callId))
    .filter((pending): pending is Promise<void> => pending !== undefined);
  const toolResultOptions = suppressedToolResultOptions(session);
  let providerResponseStarted = toolResultOptions === undefined && submissions.length > 0;
  const finalizeAgentCall = (callId: string, forcedConsult?: RealtimeVoiceForcedConsultHandle) => {
    if (session.toolCalls.isAgentCompleted(callId) || session.toolCalls.hasCancelled(callId)) {
      return;
    }
    if (forcedConsult) {
      session.harness.forcedConsults.markCancelled(forcedConsult);
    }
    broadcastToolResultToOwner(session, {
      callId,
      turnId,
      result: providerResult,
      final: true,
    });
    clearRelayAgentToolCall(session, callId);
    session.toolCalls.markAgentCompleted([callId]);
  };
  for (const callId of activeCallIds) {
    const forcedConsult = session.harness.forcedConsults
      .handles()
      .find((handle) => handle.id === callId);
    if (forcedConsult) {
      const nativeCallIds = session.harness.forcedConsults.nativeCallIds(forcedConsult);
      providerResponseStarted ||= toolResultOptions === undefined && nativeCallIds.length > 0;
      const terminal: ForcedTerminalProviderResult = {
        result: providerResult,
        options: toolResultOptions,
      };
      session.forcedTerminalProviderResults.set(callId, terminal);
      const drained = submitForcedTerminalProviderResults(session, forcedConsult, terminal);
      const tracked = completeForcedTerminalProviderResult(session, callId, terminal, drained, () =>
        finalizeAgentCall(callId, forcedConsult),
      );
      submissions.push(tracked);
      continue;
    }
    providerResponseStarted ||= toolResultOptions === undefined;
    const submitted = submitFinalProviderToolResult({
      session,
      callId,
      result: providerResult,
      options: toolResultOptions,
      onAccepted: () => finalizeAgentCall(callId),
    });
    submissions.push(trackToolResultCompletion(session.pendingFinalToolResults, callId, submitted));
  }
  const completion = completeAfterToolResultSubmissions(session, submissions, () => {});
  return {
    ...(completion ? { completion } : {}),
    providerResponseStarted,
  };
}

export function scheduleForcedAgentConsult(session: RelaySession, question: string): void {
  if (session.harness.forcedConsults.hasRecentNativeConsult(question)) {
    return;
  }
  session.harness.forcedConsults.clearPending();
  const handle = session.harness.forcedConsults.prepare(question);
  if (!handle) {
    return;
  }
  session.harness.forcedConsults.schedule(handle, FORCED_CONSULT_FALLBACK_DELAY_MS, () => {
    if (!relaySessions.has(session.id)) {
      return;
    }
    if (!session.toolCalls.tryAdmit([handle.id])) {
      return;
    }
    const turnId = ensureRelayTurn(session);
    const callId = handle.id;
    const itemId = `forced-consult-item-${randomUUID()}`;
    session.harness.forcedConsults.markStarted(handle);
    session.harness.handleBargeIn(
      { audioPlaybackActive: true, force: true },
      noFallbackRelayOutputFlush,
    );
    broadcastToOwner(session, {
      type: "toolCall",
      itemId,
      callId,
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      forced: true,
      args: {
        question: handle.question,
        context:
          "The realtime provider produced a final user transcript without invoking openclaw_agent_consult, so OpenClaw is forcing the consult for realtime Talk.",
        responseStyle: "Reply in a concise spoken tone.",
      },
      talkEvent: session.harness.talk.emit({
        type: "tool.call",
        itemId,
        callId,
        turnId,
        payload: {
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          args: { question: handle.question },
          forced: true,
        },
      }),
    });
  });
}

function submitForcedTerminalProviderResults(
  session: RelaySession,
  handle: RealtimeVoiceForcedConsultHandle,
  terminal: ForcedTerminalProviderResult,
): void | Promise<void> {
  // Each later native call submits its own terminal from onToolCall; this owner
  // joins the calls already present instead of rescanning future provider waves.
  const submissions = session.harness.forcedConsults.nativeCallIds(handle).map((providerCallId) => {
    const callId = session.relayToolCallIdsByProviderId.get(providerCallId) ?? providerCallId;
    const submit = () => {
      if (session.forcedTerminalProviderResults.get(handle.id) !== terminal) {
        return;
      }
      return submitFinalProviderToolResult({
        session,
        callId,
        result: terminal.result,
        options: terminal.options,
      });
    };
    const pending = session.pendingProviderToolResults.get(callId);
    return pending ? pending.then(submit, submit) : submit();
  });
  return completeAfterToolResultSubmissions(session, submissions, () => {});
}

export function submitRealtimeAgentConsultWorkingResponse(
  session: RelaySession,
  callId: string,
  turnId = ensureRelayTurn(session),
): void | Promise<void> {
  if (!session.bridge.bridge.supportsToolResultContinuation) {
    return;
  }
  const submission = session.bridge.submitToolResult(
    resolveRelayProviderToolCallId(session, callId),
    buildRealtimeVoiceAgentConsultWorkingResponse("person"),
    { willContinue: true },
  );
  const completion = completeAfterToolResultSubmissions(session, [submission], () => {
    if (session.toolCalls.isAgentCompleted(callId) || session.toolCalls.hasCancelled(callId)) {
      return;
    }
    broadcastToOwner(session, {
      type: "toolResult",
      callId,
      talkEvent: session.harness.talk.emit({
        type: "tool.progress",
        callId,
        turnId,
        payload: { name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, status: "working" },
      }),
    });
  });
  return trackToolResultCompletion(session.pendingWorkingToolResults, callId, completion);
}

export function submitForcedTalkRealtimeRelayToolResult(
  session: RelaySession,
  forcedConsult: RealtimeVoiceForcedConsultHandle,
  params: {
    result: unknown;
    options?: RealtimeVoiceToolResultOptions;
  },
): void | Promise<void> {
  const callId = forcedConsult.id;
  const cancelled = session.harness.forcedConsults.isCancelled(forcedConsult);
  const turnId = cancelled
    ? (session.toolCalls.cancelledTurnId(callId) ?? session.harness.talk.activeTurnId)
    : ensureRelayTurn(session);
  if (!turnId) {
    throw new Error("Cancelled realtime consult is missing its original turn");
  }
  if (cancelled) {
    const providerResult = buildRealtimeVoiceAgentCancelProviderResult(
      "OpenClaw cancelled this consult before completion. Do not restart it.",
    );
    const existing = session.forcedTerminalProviderResults.get(forcedConsult.id);
    const terminal: ForcedTerminalProviderResult = existing ?? {
      result: providerResult,
      options: suppressedToolResultOptions(session),
    };
    session.forcedTerminalProviderResults.set(forcedConsult.id, terminal);
    const drained = submitForcedTerminalProviderResults(session, forcedConsult, terminal);
    return completeForcedTerminalProviderResult(session, callId, terminal, drained, () => {
      session.harness.forcedConsults.markCancelled(forcedConsult);
      clearRelayAgentToolCall(session, callId);
      session.toolCalls.deleteCancelled(callId);
      if (!session.toolCalls.markAgentCompleted([callId])) {
        return;
      }
      broadcastToolResultToOwner(session, {
        callId,
        turnId,
        result: providerResult,
        forced: true,
        final: true,
      });
    });
  }
  const suppressResponse = params.options?.suppressResponse === true;
  const final = params.options?.willContinue !== true;
  if (!final) {
    if (!suppressResponse && asOptionalRecord(params.result)?.status === "working") {
      session.bridge.sendUserMessage(FORCED_CONSULT_CHECKING_PROMPT);
    }
    broadcastToolResultToOwner(session, {
      callId,
      turnId,
      result: params.result,
      forced: true,
      final: false,
    });
    return;
  }
  const text = readSpeakableRealtimeVoiceToolResult(params.result, {
    maxChars: FORCED_CONSULT_RESULT_MAX_CHARS,
  });
  const providerOptions = suppressedToolResultOptions(session);
  const providerResult = providerOptions ? buildAlreadyDeliveredToolResult() : params.result;
  const terminal: ForcedTerminalProviderResult = {
    result: providerResult,
    options: providerOptions,
  };
  session.forcedTerminalProviderResults.set(forcedConsult.id, terminal);
  const submission = submitForcedTerminalProviderResults(session, forcedConsult, terminal);
  return completeForcedTerminalProviderResult(session, callId, terminal, submission, () => {
    session.harness.forcedConsults.markDelivered(forcedConsult);
    clearRelayAgentToolCall(session, callId);
    if (!session.toolCalls.markAgentCompleted([callId])) {
      return;
    }
    const hasNativeCalls = session.harness.forcedConsults.nativeCallIds(forcedConsult).length > 0;
    if (!suppressResponse && text && (!hasNativeCalls || providerOptions)) {
      session.bridge.sendUserMessage(buildForcedConsultSpeechPrompt(text));
    }
    broadcastToolResultToOwner(session, {
      callId,
      turnId,
      result: params.result,
      forced: true,
      final: true,
    });
  });
}
