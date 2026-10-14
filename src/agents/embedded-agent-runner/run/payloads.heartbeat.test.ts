// Exercise the full tool-failure and media pipeline before the notification decision.
import { describe, expect, it } from "vitest";
import {
  resolveHeartbeatReplyPayload,
  resolveHeartbeatTerminalToolFailure,
} from "../../../auto-reply/heartbeat-reply-payload.js";
import { selectHeartbeatToolResponse } from "../../../auto-reply/heartbeat-tool-response.js";
import { classifyHeartbeatAgentOutcome } from "../../../infra/heartbeat-delivery-normalization.js";
import { createToolTerminalObserver } from "../../tool-terminal-outcome.js";
import { buildPayloads } from "./payloads.test-helpers.js";
import { mergeAttemptToolMediaPayloads } from "./tool-media-payloads.js";

describe("quiet heartbeat failures", () => {
  it.each([
    { command: "/usr/bin/zsh -lc 'rg absent notes.md'", exitCode: 1, mutation: false },
    { command: "/usr/bin/zsh -lc 'rg pattern missing.md'", exitCode: 2, mutation: false },
    { command: "/usr/bin/zsh -lc 'sed -i s/a/b/ notes.md'", exitCode: 1, mutation: true },
  ])(
    "preserves $command diagnostics without inventing a failed mutation",
    ({ command, exitCode, mutation }) => {
      const observe = createToolTerminalObserver("heartbeat-native-command");
      const failed = observe({
        toolName: "bash",
        arguments: { command },
        nativeCommand: { format: "shell-argv", command },
        replaySafe: false,
        executionStarted: true,
        outcome: "failure",
        result: { details: { status: "failed", exitCode } },
        failure: { error: `Command exited with code ${exitCode}` },
      });
      expect(failed.sideEffectEvidence).toBe(true);
      const heartbeatToolResponse = {
        outcome: "no_change" as const,
        notify: false,
        summary: "Nothing needs attention.",
      };
      const terminal = observe({
        toolName: "heartbeat_respond",
        arguments: heartbeatToolResponse,
        outcome: "success",
      });
      expect(terminal.lastToolError).toMatchObject({
        toolName: "bash",
        error: `Command exited with code ${exitCode}`,
        mutatingAction: mutation,
      });
      const payloads = buildPayloads({
        heartbeatToolResponse,
        isHeartbeatTrigger: true,
        lastToolError: terminal.lastToolError,
      });
      const outcome = classifyHeartbeatAgentOutcome({
        agentRun: {
          agentRunFailed: false,
          heartbeatToolResponse: selectHeartbeatToolResponse(payloads)?.response,
          heartbeatTerminalToolFailure: resolveHeartbeatTerminalToolFailure(payloads),
          replyPayload: resolveHeartbeatReplyPayload(payloads),
        },
        useHeartbeatFailureCopy: true,
        hasRelayableExecCompletion: false,
        suppressUnmarkedSourceReplies: false,
        responsePrefix: undefined,
        ackMaxChars: 300,
      });
      expect(outcome).toMatchObject(
        mutation
          ? { kind: "failure", reason: "agent-tool-failure" }
          : { kind: "ack", eventStatus: "ok-token" },
      );
    },
  );

  it.each(["message", "exec"])(
    "does not notify after a failed %s and generated media",
    (toolName) => {
      const payloads = buildPayloads({
        assistantTexts: ["Everything is fine."],
        heartbeatToolResponse: {
          outcome: "no_change",
          notify: false,
          summary: "Nothing needs attention.",
        },
        isHeartbeatTrigger: true,
        lastToolError: { toolName, error: "operation failed", mutatingAction: true },
      });
      const merged = mergeAttemptToolMediaPayloads({
        payloads,
        toolMediaUrls: ["/tmp/heartbeat.png"],
        hostOwnedToolMediaUrls: ["/tmp/heartbeat.png"],
        toolAutoDeliveryMediaUrls: ["/tmp/heartbeat.opus"],
        toolAudioAsVoice: true,
        sourceReplyDeliveryMode: "message_tool_only",
      });
      expect(
        classifyHeartbeatAgentOutcome({
          agentRun: {
            agentRunFailed: false,
            heartbeatToolResponse: selectHeartbeatToolResponse(merged)?.response,
            heartbeatTerminalToolFailure: { toolName },
            replyPayload: resolveHeartbeatReplyPayload(merged),
          },
          useHeartbeatFailureCopy: true,
          hasRelayableExecCompletion: false,
          suppressUnmarkedSourceReplies: false,
          responsePrefix: undefined,
          ackMaxChars: 300,
        }),
      ).toMatchObject({ kind: "failure", reason: "agent-tool-failure", shouldSkipMain: true });
    },
  );
});
