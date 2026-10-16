import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import { projectChatDisplayMessage } from "./chat-display-projection.core.js";
import {
  createActiveRun,
  createGatewayBroadcaster,
  createHandler,
  createTranscriptUpdateBroadcastHandler,
  listAccessorSessionEntriesReadOnlyMock,
  loadAccessorSessionEntryReadOnlyMock,
  loadGatewaySessionEntryReadOnlyMock,
  loadGatewaySessionRowMock,
  readSessionMessageByIdAsyncMock,
  readSessionMessageCountAsyncMock,
  projectChatDisplayMessageMock,
  resolveEmbeddedAgentSessionProgressStateMock,
  runtimeConfigState,
  sessionRow,
  storedMessage,
  subscribePluginSessionsChanged,
} from "./server-session-events.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

describe("live failed-attempt presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectChatDisplayMessageMock.mockImplementation(projectChatDisplayMessage);
    resolveEmbeddedAgentSessionProgressStateMock.mockReturnValue(undefined);
    listAccessorSessionEntriesReadOnlyMock.mockReturnValue([]);
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue(undefined);
    loadGatewaySessionEntryReadOnlyMock.mockReturnValue({ entry: undefined, storePath: "" });
    loadGatewaySessionRowMock.mockReturnValue(sessionRow);
    readSessionMessageCountAsyncMock.mockReset().mockResolvedValue(undefined);
    readSessionMessageByIdAsyncMock.mockReset();
    runtimeConfigState.value = {};
    sessionRow.key = "agent:main:main";
  });

  it.each([false, true])(
    "publishes message-phase changes to plugins without websockets (unbound marker: %s)",
    async (unboundMarker) => {
      readSessionMessageByIdAsyncMock.mockImplementation(async (_scope, id: string) =>
        storedMessage(id),
      );
      sessionRow.thinkingLevel = "ultra";
      const received = vi.fn();
      const unsubscribe = subscribePluginSessionsChanged(received);
      const { broadcastToConnIds } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(),
      });
      const handler = createTranscriptUpdateBroadcastHandler({
        broadcastToConnIds,
        sessionEventSubscribers: { getAll: () => new Set() },
        sessionMessageSubscribers: { get: () => new Set() },
        chatAbortControllers: new Map(),
      });
      if (unboundMarker) {
        listAccessorSessionEntriesReadOnlyMock
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValue([{ key: "agent:main:main", entry: sessionRow }]);
      } else {
        projectChatDisplayMessageMock.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);
      }

      try {
        await handler({
          ...(unboundMarker
            ? { sessionFile: "sqlite:main:sess-main:/tmp/unbound-plugin.sqlite" }
            : { sessionFile: "/tmp/sess-main.jsonl", sessionKey: "agent:main:main" }),
          message: unboundMarker
            ? { role: "assistant", content: "Original message" }
            : { role: "toolResult", content: [] },
          messageId: "message-1",
          messageSeq: 1,
        });
        expect(received).toHaveBeenCalledOnce();
        expect(received).toHaveBeenCalledWith({
          sessionKey: "agent:main:main",
          ...(unboundMarker ? { agentId: "main" } : {}),
          phase: "message",
        });
      } finally {
        unsubscribe();
      }
    },
  );

  it.each([
    { kind: "empty", unboundMarker: false },
    { kind: "overflow", unboundMarker: false },
    { kind: "sentinel", unboundMarker: false },
    { kind: "overload", unboundMarker: false },
    { kind: "overload", unboundMarker: true },
  ])(
    "does not publish a diagnostic-only $kind failure (unbound marker: $unboundMarker)",
    async ({ kind, unboundMarker }) => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          kind === "overload" ? "503 service overloaded" : "request exceeds the available context",
        content:
          kind === "empty" || kind === "overload"
            ? []
            : [
                {
                  type: "text",
                  text:
                    kind === "overflow"
                      ? CONTEXT_OVERFLOW_ERROR_MESSAGE
                      : STREAM_ERROR_FALLBACK_TEXT,
                },
              ],
        __openclaw: { runId: "recovering-run" },
      };
      readSessionMessageByIdAsyncMock.mockResolvedValue({
        found: true,
        oversized: false,
        seq: 2,
        message,
      });
      const broadcastToConnIds = vi.fn();
      const activeRun = createActiveRun(true);
      const controllers = new Map([["recovering-run", activeRun]]);
      const handler = createTranscriptUpdateBroadcastHandler({
        broadcastToConnIds,
        sessionEventSubscribers: { getAll: () => new Set(["broad"]) },
        sessionMessageSubscribers: { get: () => new Set(["selected"]) },
        chatAbortControllers: controllers,
      });
      const target = {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/recovery.sqlite",
      };
      if (unboundMarker) {
        listAccessorSessionEntriesReadOnlyMock
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValue([{ key: target.sessionKey, entry: sessionRow }]);
      }
      const update = {
        ...(unboundMarker
          ? { sessionFile: "sqlite:main:sess-main:/tmp/recovery.sqlite" }
          : { target }),
        messageId: "failed-attempt",
        message,
        runId: "recovering-run",
      };
      await handler(update);
      // Neither a message nor a broad history invalidation may leak the pending row.
      expect(broadcastToConnIds).not.toHaveBeenCalled();

      // Keeping the idempotency entry is not evidence that execution is still active.
      activeRun.projectSessionActive = false;
      broadcastToConnIds.mockClear();
      await handler(update);
      expect(broadcastToConnIds).not.toHaveBeenCalled();
      const terminal = {
        role: "custom",
        customType: "run-failed-before-reply",
        content: "Recovery exhausted.",
        details: { runId: "recovering-run" },
      };
      readSessionMessageByIdAsyncMock.mockResolvedValue({
        found: true,
        oversized: false,
        seq: 3,
        message: terminal,
      });
      await handler({ ...update, target, messageId: "terminal", message: terminal });
      expect(broadcastToConnIds.mock.calls.map(([event]) => event)).toEqual(["session.message"]);
      expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({
        messageId: "terminal",
        hasActiveRun: false,
        message: { openclawRunError: { runId: "recovering-run", summary: "Recovery exhausted." } },
      });
    },
  );

  it.each(["same run", "other run", "other session"])(
    "does not infer terminal failure from projected liveness: %s",
    async (scenario) => {
      const runId = "projected-error-run";
      registerAgentRunContext(runId, {
        agentId: "main",
        sessionKey: scenario === "other session" ? "agent:main:other" : "agent:main:main",
        sessionId: scenario === "other session" ? "sess-other" : "sess-main",
        projectSessionActive: true,
      });
      try {
        const { handler, broadcastToConnIds } = createHandler(false);
        await handler({
          sessionFile: "/tmp/sess-main.jsonl",
          sessionKey: "agent:main:main",
          messageId: "projected-failure",
          messageSeq: 3,
          // The transcript identity wins over an unrelated update envelope.
          runId,
          message: {
            role: "assistant",
            stopReason: "error",
            content: [],
            __openclaw: { runId: scenario === "other run" ? "settled-error-run" : runId },
          },
        });
        expect(broadcastToConnIds.mock.calls.map(([event]) => event)).toEqual([]);
      } finally {
        clearAgentRunContext(runId);
      }
    },
  );
});
