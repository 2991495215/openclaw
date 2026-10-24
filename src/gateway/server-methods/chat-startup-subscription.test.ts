import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import {
  historyPayload,
  historyRpc,
  seedHistorySession,
  withHistoryState,
} from "./chat-history-fixture.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
} from "./sessions-read-cache.test-support.js";

afterEach(disposeSessionReadContexts);

it("admits the full stream before reading the startup cursor and catches activity since the retained snapshot", async () => {
  await withHistoryState(async () => {
    setRuntimeConfigSnapshot({});
    const scope = await seedHistorySession("atomic-startup");
    await appendTranscriptMessage(scope, {
      eventId: "cached",
      message: { role: "user", content: "Before reload" },
    });
    const subscribers = createSessionMessageSubscriberRegistry();
    const context = await createHistoryReadContext({
      subscribeSessionMessageEvents: subscribers.subscribe,
    });
    const client = {
      ...sharingPolicyClient({ scopes: ["operator.admin"] }),
      connId: "atomic-reader",
    };
    const rpc = historyRpc(context, scope.sessionKey);
    const cached = historyPayload(await rpc("chat.startup", {}, { client }));
    await appendTranscriptMessage(scope, {
      eventId: "between",
      message: { role: "assistant", content: "Between cached snapshot and admission" },
    });
    const readStartup = vi.fn(async () => {
      expect([...subscribers.get(scope.sessionKey)]).toEqual([client.connId]);
      return undefined;
    });
    context.readChatStartupProjection = readStartup;
    const result = historyPayload(
      await rpc(
        "chat.startup",
        {
          cursor: cached.deltaCursor,
          subscription: { subscriptionId: "pane" },
        },
        { client },
      ),
    );
    // Exercise the real serializer too: the cursor's messages may be serialized segments.
    const wire = JSON.parse(serializeGatewayFrame({ type: "res", payload: result }).toString());
    expect(wire.payload).toMatchObject({
      kind: "delta",
      subscription: { subscribed: true, key: scope.sessionKey, agentId: "main" },
      messages: [
        { messageId: "between", message: { content: "Between cached snapshot and admission" } },
      ],
    });
    expect(readStartup).toHaveBeenCalledOnce();
    expect(wire.payload.messages).toHaveLength(1);
    subscribers.unsubscribe(client.connId, scope.sessionKey, "pane");
    expect(subscribers.get(scope.sessionKey).size).toBe(0);
  });
});

it("refuses an unauthorized approval subscription before disclosing startup history", async () => {
  await withHistoryState(async () => {
    setRuntimeConfigSnapshot({});
    const scope = await seedHistorySession("atomic-approval");
    const subscribers = createSessionMessageSubscriberRegistry();
    const context = await createHistoryReadContext({
      subscribeSessionMessageEvents: subscribers.subscribe,
    });
    const result = await historyRpc(context, scope.sessionKey)(
      "chat.startup",
      {
        subscription: { subscriptionId: "pane", includeApprovals: true },
      },
      { client: { ...sharingPolicyClient({}), connId: "denied" } },
    );
    expect(result.mock.calls[0]?.slice(0, 3)).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST" },
    ]);
    expect(subscribers.get(scope.sessionKey).size).toBe(0);
  });
});

it.each(["session", "approvals"] as const)(
  "rolls back admission when %s authority is revoked during startup",
  async (revoked) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot({});
      const client = { ...identifiedClient("viewer"), connId: "startup-viewer" };
      client.connect.scopes = ["operator.read", "operator.approvals"];
      client.connect.device = sharingPolicyClient({ deviceId: "startup-device" }).connect.device;
      const subscribers = createSessionMessageSubscriberRegistry();
      const scope = await seedHistorySession("startup-revoked", {
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "owner" },
      });
      await appendTranscriptMessage(scope, {
        eventId: "initial",
        message: { role: "user", content: "Initial history" },
      });
      const revoke = vi.fn(async () => {
        if (revoked === "session") {
          await patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
        } else {
          client.connect.scopes = ["operator.read"];
        }
        return undefined;
      });
      const context = await createHistoryReadContext({
        subscribeSessionMessageEvents: subscribers.subscribe,
        listSessionPendingApprovals: async () => ({
          replay: { sessionKey: scope.sessionKey, updatedAtMs: 1, approvals: [], truncated: false },
          isCurrent: () => true,
          release: () => {},
        }),
        readChatStartupProjection: revoke,
      });
      const result = await historyRpc(context, scope.sessionKey)(
        "chat.startup",
        {
          subscription: { subscriptionId: "pane", includeApprovals: true },
        },
        { client },
      );
      expect(revoke).toHaveBeenCalledOnce();
      expect(result.mock.calls[0]?.slice(0, 2)).toEqual([false, undefined]);
      expect(subscribers.get(scope.sessionKey).size).toBe(0);
      expect(subscribers.getApprovals(scope.sessionKey).size).toBe(0);
    });
  },
);
