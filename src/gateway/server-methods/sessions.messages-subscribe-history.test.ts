import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { seedHistoryTranscript } from "./chat-history-fixture.test-support.js";
import { requestHistory } from "./chat-history-fixtures.test-support.js";
import * as historyPages from "./chat-history-pages.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type { RespondFn } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it.each(["ready", "busy", "failed"] as const)(
  "admits the observer before initial history and retains its receipt when history is %s",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const client = {
        ...sharingPolicyClient({ scopes: ["operator.admin"] }),
        connId: "history-reader",
      };
      const subscribers = createSessionMessageSubscriberRegistry();
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:subscription-history",
        sessionId: "subscription-history",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "history-owner" },
      });
      await seedHistoryTranscript(scope, [["answer", { role: "assistant", content: "Ready" }]]);
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => cfg,
        subscribeSessionMessageEvents: subscribers.subscribe,
        unsubscribeSessionMessageEvents: subscribers.unsubscribe,
      });
      if (outcome === "ready") {
        const direct = await requestHistory(
          "chat.startup",
          { sessionKey: scope.sessionKey },
          context,
          client,
        );
        expect(direct.mock.calls[0]?.[0], JSON.stringify(direct.mock.calls)).toBe(true);
      }
      const readHistory = historyPages.readChatHistoryPage;
      let observedDuringRead = false;
      const read = vi.spyOn(historyPages, "readChatHistoryPage").mockImplementation((...args) => {
        observedDuringRead = subscribers.get(scope.sessionKey).has(client.connId);
        if (outcome !== "ready") {
          throw new WorkerTaskError(
            "synthetic history failure",
            outcome === "busy" ? "overloaded" : "failed",
          );
        }
        return readHistory(...args);
      });
      const respond = vi.fn<RespondFn>();
      try {
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "subscribe-with-history",
            method: "sessions.messages.subscribe",
            params: {
              key: scope.sessionKey,
              subscriptionId: "foreground",
              initialHistory: { limit: 80, maxBytes: 256 * 1024, toolResultMaxChars: 2_000 },
            },
          },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionSubscriptionHandlers,
        });
        expect(read, JSON.stringify(respond.mock.calls)).toHaveBeenCalledOnce();
        expect(observedDuringRead).toBe(true);
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          {
            subscribed: true,
            key: scope.sessionKey,
            agentId: scope.agentId,
            initialHistory:
              outcome === "ready"
                ? {
                    ok: true,
                    payload: expect.objectContaining({
                      messages: expect.arrayContaining([
                        expect.objectContaining({ role: "assistant", content: "Ready" }),
                      ]),
                    }),
                  }
                : {
                    ok: false,
                    error: expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
                  },
          },
          undefined,
        );
        expect(subscribers.get(scope.sessionKey)).toEqual(new Set([client.connId]));
        subscribers.unsubscribe(client.connId, scope.sessionKey, "foreground");
        expect(subscribers.get(scope.sessionKey).size).toBe(0);
      } finally {
        read.mockRestore();
        await disposeSessionReadContexts();
      }
    });
  },
);
