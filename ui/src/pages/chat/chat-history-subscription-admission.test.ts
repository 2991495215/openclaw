// @vitest-environment node
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { disposeSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";

it.each(["overlap", "selection", "connection", "deleted", "read failure"] as const)(
  "owns the combined snapshot and live stream through %s",
  async (change) => {
    const key = "agent:main:selected";
    const requested = createDeferred();
    const response = createDeferred<unknown>();
    const cached = { role: "user", content: "Before reload", __openclaw: { id: "cached", seq: 1 } };
    const appended = {
      role: "user",
      content: "During reload",
      __openclaw: { id: "appended", seq: 2 },
    };
    const state = makeChatHost({
      sessionKey: key,
      currentSessionId: "selected",
      chatMessages: [cached],
      chatHistoryPagination: { hasMore: false, completeSnapshot: true },
      requestHandlers: {
        "chat.startup": (params: { subscription?: unknown }) => {
          requested.resolve();
          return response.promise;
        },
      },
    });
    const loading = loadChatHistory(state, { startup: true, deferBranches: true });
    await requested.promise;
    expect(requestCalls(state.request, "chat.startup")[0]?.[1]).toMatchObject({
      subscription: { subscriptionId: expect.any(String) },
    });
    expect(requestCalls(state.request, "sessions.messages.subscribe")).toHaveLength(0);
    if (change === "overlap") {
      applySessionMessagePayload(
        state,
        {
          sessionKey: key,
          sessionId: "selected",
          messageId: "appended",
          messageSeq: 2,
          message: appended,
        },
        false,
        { kind: "live", activeRunId: null },
      );
      expect(state.chatMessages).toEqual([cached, appended]);
    } else if (change === "selection") {
      state.sessionKey = "agent:main:replacement";
    } else if (change === "connection") {
      disposeSelectedSessionMessageSubscription(state);
      state.sessions.dispose();
      const client = createTestGatewayClient(async () => ({
        messages: [],
        sessionInfo: { key, sessionId: "reconnected" },
      }));
      state.client = client;
      state.connectionEpoch++;
      state.sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
    }
    response.resolve({
      subscription: { subscribed: true, key, agentId: "main" },
      ...(change === "read failure"
        ? { startupError: { code: "INVALID_REQUEST", message: "Session was deleted" } }
        : {
            messages: change === "deleted" ? [] : [cached, appended],
            sessionId: change === "deleted" ? null : "selected",
            sessionInfo: { key, ...(change === "deleted" ? {} : { sessionId: "selected" }) },
          }),
    });
    await loading;
    if (change === "overlap") {
      expect(
        getChatHistoryLoadState(state),
        JSON.stringify(getChatHistoryLoadState(state)),
      ).toMatchObject({ phase: "committed" });
      expect(state.chatMessages).toEqual([cached, appended]);
      expect(getChatHistoryLoadState(state).phase).toBe("committed");
    } else if (change === "deleted") {
      expect(state.chatMessages).toEqual([]);
      expect(state.currentSessionId).toBeNull();
    } else if (change === "read failure") {
      expect(getChatHistoryLoadState(state)).toMatchObject({
        phase: "failed",
        message: "Session was deleted",
      });
      expect(state.chatSessionMessageSubscription).not.toBeNull();
    } else {
      expect(state.chatMessages).toEqual([cached]);
      expect(requestCalls(state.request, "sessions.messages.unsubscribe")).toHaveLength(1);
      if (change === "connection") {
        await loadChatHistory(state, { startup: true, deferBranches: true });
        expect(state.currentSessionId).toBe("reconnected");
      }
    }
    disposeSelectedSessionMessageSubscription(state);
  },
);
