/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import * as outboxPayloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createDeliveryAttachmentBatch,
  reloadChatDocumentStorage,
} from "./chat-delivery-attachments.test-support.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { makeChatHost, requestCalls, requireRecord } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  admitHostQueueItems,
  idleChatHistory as historyWithoutSession,
} from "./chat-outbox-recovery.test-support.ts";
import { resumeStoredChatOutboxes, retryQueuedChatMessage } from "./chat-send-actions.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

const CHAT_OUTBOX_AUTO_RESEND_WINDOW_MS = 2 * 60_000;
const CHAT_OUTBOX_AUTO_RESEND_MAX = 3;
const ORIGINAL_SESSION_ID = "original-session";

useChatSendBrowserFixture();

function idleChatHistory() {
  const history = historyWithoutSession();
  return { ...history, sessionInfo: { ...history.sessionInfo, sessionId: ORIGINAL_SESSION_ID } };
}

function makeResendHost(overrides: Parameters<typeof makeChatHost>[0]) {
  return makeChatHost({
    currentSessionId: ORIGINAL_SESSION_ID,
    ...overrides,
    requestHandlers: overrides?.requestHandlers ?? {},
  });
}

function reconnect(host: ChatHost, generation: number): void {
  host.connected = true;
  host.connectionEpoch = generation;
  vi.spyOn(host.client!, "connectionGeneration", "get").mockReturnValue(generation);
}

describe("automatic reconnect resend", () => {
  it.each(["ok", "in_flight"])(
    "reuses the interrupted key, accepts %s, and releases FIFO without another resend",
    async (status) => {
      const ack = createDeferred<unknown>();
      let attempts = 0;
      const host = makeResendHost({
        chatMessage: "interrupted first",
        requestHandlers: {
          "chat.history": () => idleChatHistory(),
          "chat.send": () => {
            attempts += 1;
            if (attempts === 1) {
              throw new Error("gateway disconnected");
            }
            return attempts === 2 ? ack.promise : { status: "ok", messageSeq: 2 };
          },
        },
      });
      await handleSendChat(host);
      const first = listStoredChatOutboxes(host)[0]!.queue[0]!;
      host.chatMessage = "queued second";
      host.connected = false;
      await handleSendChat(host);
      reconnect(host, 1);
      const resumed = resumeStoredChatOutboxes(host);
      try {
        // Observe the transport boundary, not a private retry helper.
        await waitForFast(() => expect(attempts).toBe(2));
        expect(host.chatQueue[0]).toMatchObject({
          sendState: "sending",
          sendRunId: first.sendRunId,
          sendAutoResends: 1,
        });
        expect(
          requestCalls(host.request, "chat.send").map(
            ([, p]) => requireRecord(p, "send request").message,
          ),
        ).toEqual(["interrupted first", "interrupted first"]);
      } finally {
        ack.resolve({ runId: first.sendRunId, status, messageSeq: 1 });
        await resumed;
      }
      if (status === "in_flight") {
        // The ACK's sequence proves consumption; its active run must still finish before FIFO resumes.
        expect(requestCalls(host.request, "chat.send")).toHaveLength(2);
        handleChatGatewayEvent(host, {
          sessionKey: host.sessionKey,
          runId: first.sendRunId!,
          seq: 1,
          state: "final",
          message: { role: "assistant", content: "Finished" },
        });
      }
      await resumeStoredChatOutboxes(host);
      const sends = requestCalls(host.request, "chat.send").map(([, p]) =>
        requireRecord(p, "send request"),
      );
      expect(sends.map((p) => p.message)).toEqual([
        "interrupted first",
        "interrupted first",
        "queued second",
      ]);
      expect(sends[1]!.idempotencyKey).toBe(sends[0]!.idempotencyKey);
      expect(listStoredChatOutboxes(host)).toEqual([]);
    },
  );

  it.each(["disconnect", "rejection"])(
    "preserves the first attempt and cap after %s",
    async (failure) => {
      let calls = 0;
      const host = makeResendHost({
        chatMessage: "keep failing",
        requestHandlers: {
          "chat.history": () => idleChatHistory(),
          "chat.send": () => {
            if (++calls > 1 && failure === "rejection") {
              throw new GatewayRequestError({
                code: "UNAVAILABLE",
                message: "busy",
                retryable: true,
                retryAfterMs: 30_000,
              });
            }
            throw new Error("gateway disconnected");
          },
        },
      });
      await handleSendChat(host);
      const first = listStoredChatOutboxes(host)[0]!.queue[0]!;
      host.connected = false;
      host.chatMessage = "wait behind failing first";
      await handleSendChat(host);
      host.connected = true;
      for (let epoch = 1; epoch <= CHAT_OUTBOX_AUTO_RESEND_MAX; epoch += 1) {
        reconnect(host, epoch);
        await resumeStoredChatOutboxes(host);
        await resumeStoredChatOutboxes(host);
        expect(requestCalls(host.request, "chat.send")).toHaveLength(epoch + 1);
        expect(listStoredChatOutboxes(host)[0]!.queue[0]).toMatchObject({
          sendFirstAttemptAtMs: first.sendFirstAttemptAtMs,
          sendAutoResends: epoch,
        });
      }
      reconnect(host, CHAT_OUTBOX_AUTO_RESEND_MAX + 1);
      await resumeStoredChatOutboxes(host);
      expect(host.chatQueue[0]).toMatchObject({ sendState: "unconfirmed" });
      expect(host.chatQueue.map((item) => item.text)).toEqual([
        "keep failing",
        "wait behind failing first",
      ]);
      expect(requestCalls(host.request, "chat.send")).toHaveLength(4);
      expect(
        requestCalls(host.request, "chat.send").map(
          ([, p]) => requireRecord(p, "send request").idempotencyKey,
        ),
      ).toEqual(Array(4).fill(first.sendRunId));
    },
  );

  it("shares resend suppression across panes with different connection epochs", async () => {
    const host = makeResendHost({
      chatMessage: "one attempt per socket",
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": () => {
          throw new Error("gateway disconnected");
        },
      },
    });
    await handleSendChat(host);
    reconnect(host, 1);
    await resumeStoredChatOutboxes(host);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(2);

    const sibling = makeResendHost({
      client: host.client,
      connectionEpoch: 99,
      sessions: host.sessions,
    });
    await resumeStoredChatOutboxes(sibling);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(2);
    expect(sibling.chatQueue[0]).toMatchObject({ sendAutoResends: 1 });
  });

  it("reconciles again after reconnecting while resend settings are pending", async () => {
    const settings = createDeferred<boolean>();
    const host = makeResendHost({
      chatQueue: [
        {
          id: "uncertain",
          text: "wait for current proof",
          createdAt: 1,
          sendAttempts: 1,
          sendRunId: "original",
          sessionId: ORIGINAL_SESSION_ID,
          sendState: "waiting-reconnect",
          sendFirstAttemptAtMs: Date.now(),
        },
      ],
      pendingSettingsPatches: { "agent:main": settings.promise },
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": () => ({ status: "ok", messageSeq: 1 }),
      },
    });
    admitHostQueueItems(host);
    reconnect(host, 1);
    const resumed = resumeStoredChatOutboxes(host);
    try {
      await waitForFast(() => expect(host.chatQueue[0]?.sendState).toBe("waiting-model"));
      reconnect(host, 2);
    } finally {
      settings.resolve(true);
      await resumed;
    }
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-reconnect",
      sendAttempts: 1,
      sendRunId: "original",
    });
    const oldReads = requestCalls(host.request, "chat.history").length;
    await resumeStoredChatOutboxes(host);
    expect(requestCalls(host.request, "chat.history").length).toBeGreaterThan(oldReads);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    expect(listStoredChatOutboxes(host)).toEqual([]);
  });

  it.each([false, true])(
    "restores resend metadata before transport (resend=%s)",
    async (resend) => {
      let calls = 0;
      const host = makeResendHost({
        chatMessage: "not sent to transport",
        requestHandlers: {
          "chat.history": () => idleChatHistory(),
          "chat.send": () => {
            calls += 1;
            throw new Error(
              resend && calls === 1 ? "gateway disconnected" : "gateway not connected",
            );
          },
        },
      });
      await handleSendChat(host);
      const before = listStoredChatOutboxes(host)[0]!.queue[0]!;
      if (resend) {
        reconnect(host, 1);
        await resumeStoredChatOutboxes(host);
      }
      const current = listStoredChatOutboxes(host)[0]!.queue[0]!;
      expect(current.sendAttempts).toBe(resend ? 1 : 0);
      expect(current.sendFirstAttemptAtMs).toBe(resend ? before.sendFirstAttemptAtMs : undefined);
      expect(current.sendAutoResends ?? 0).toBe(0);
      expect(current.sessionId).toBe(resend ? ORIGINAL_SESSION_ID : undefined);
      expect(requestCalls(host.request, "chat.send")).toHaveLength(resend ? 2 : 1);
    },
  );

  it("keeps an interrupted ordinary send bound to its original physical session", async () => {
    let currentSessionId = ORIGINAL_SESSION_ID;
    let recordedSessionId: string | undefined;
    const host = makeResendHost({
      chatMessage: "belongs to the original conversation",
      requestHandlers: {
        "chat.history": () => {
          const history = idleChatHistory();
          return {
            ...history,
            sessionInfo: { ...history.sessionInfo, sessionId: currentSessionId },
          };
        },
        "chat.send": () => {
          recordedSessionId = listStoredChatOutboxes(host)[0]?.queue[0]?.sessionId;
          throw new Error("gateway disconnected");
        },
      },
    });
    await handleSendChat(host);
    expect(recordedSessionId).toBe(ORIGINAL_SESSION_ID);
    const first = listStoredChatOutboxes(host)[0]!.queue[0]!;
    currentSessionId = "replacement-session";
    host.currentSessionId = currentSessionId;
    reconnect(host, 1);
    await resumeStoredChatOutboxes(host);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    expect(host.chatQueue[0]).toMatchObject({
      sessionId: ORIGINAL_SESSION_ID,
      sendRunId: first.sendRunId,
      sendState: "unconfirmed",
    });
  });

  it("keeps attempted rows without an original physical target for manual review", async () => {
    const host = makeResendHost({
      chatQueue: [
        {
          id: "unknown-target",
          text: "legacy attempted message",
          createdAt: 1,
          sendAttempts: 1,
          sendRunId: "original",
          sendState: "waiting-reconnect",
          sendFirstAttemptAtMs: Date.now(),
        },
      ],
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": () => ({ status: "ok", messageSeq: 1 }),
      },
    });
    admitHostQueueItems(host);
    await resumeStoredChatOutboxes(host);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]?.sendState).toBe("unconfirmed");
    await retryQueuedChatMessage(host, "unknown-target");
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    expect(listStoredChatOutboxes(host)).toEqual([]);
  });

  it("does not automatically resend a send the Gateway rejected", async () => {
    let attempts = 0;
    const host = makeResendHost({
      chatMessage: "rejected first",
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": () => {
          attempts += 1;
          throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "message rejected" });
        },
      },
    });
    await handleSendChat(host);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({ sendState: "failed" });

    host.connectionEpoch = 1;
    await resumeStoredChatOutboxes(host);
    expect(attempts).toBe(1);
    expect(host.chatQueue[0]).toMatchObject({ sendState: "failed" });
  });

  it("parks without transport when attachment preparation outlasts the retry window", async () => {
    sessionStorage.setItem("openclaw.control.outboxTab.v1", "test-outbox-tab");
    const { attachments } = createDeliveryAttachmentBatch();
    let sends = 0;
    const requestHandlers = {
      "chat.history": () => idleChatHistory(),
      "chat.send": () => {
        sends += 1;
        throw new Error("gateway disconnected");
      },
    };
    const source = makeResendHost({
      chatMessage: "slow attachment",
      chatAttachments: attachments,
      requestHandlers,
    });
    await handleSendChat(source);
    const first = listStoredChatOutboxes(source)[0]!.queue[0]!;
    reloadChatDocumentStorage(attachments);
    const releasePayload = createDeferred();
    const readPayload = outboxPayloadStore.readOutboxPayload;
    vi.spyOn(outboxPayloadStore, "readOutboxPayload").mockImplementation(async (...args) => {
      await releasePayload.promise;
      return readPayload(...args);
    });
    const host = makeResendHost({ requestHandlers });
    onTestFinished(chatOutboxOwner(host).subscribe(host));
    const resumed = resumeStoredChatOutboxes(host);
    try {
      await waitForFast(() =>
        expect(requestCalls(host.request, "chat.history").length).toBeGreaterThanOrEqual(2),
      );
      vi.spyOn(Date, "now").mockReturnValue(
        first.sendFirstAttemptAtMs! + CHAT_OUTBOX_AUTO_RESEND_WINDOW_MS + 1,
      );
    } finally {
      releasePayload.resolve();
      await resumed;
    }
    expect(sends).toBe(1);
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "unconfirmed",
      sendAttempts: 1,
      sendRunId: first.sendRunId,
      sendFirstAttemptAtMs: first.sendFirstAttemptAtMs,
    });
  });

  it.each([undefined, Date.now() - CHAT_OUTBOX_AUTO_RESEND_WINDOW_MS - 1])(
    "keeps legacy or expired attempts as a review barrier (%s)",
    async (sendFirstAttemptAtMs) => {
      const host = makeResendHost({
        chatQueue: [
          {
            id: "first",
            text: "uncertain",
            createdAt: 1,
            sendAttempts: 1,
            sendRunId: "original",
            sendState: "waiting-reconnect",
            sendFirstAttemptAtMs,
            sessionId: ORIGINAL_SESSION_ID,
          },
          { id: "second", text: "later", createdAt: 2, sendAttempts: 0 },
        ],
        requestHandlers: { "chat.history": () => idleChatHistory() },
      });
      admitHostQueueItems(host);
      await resumeStoredChatOutboxes(host);
      expect(host.chatQueue.map((item) => item.id)).toEqual(["first", "second"]);
      expect(host.chatQueue[0]!.sendState).toBe("unconfirmed");
      expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    },
  );

  it.each(["pending", "consumed"] as const)(
    "honors exact %s custody before automatically resending",
    async (state) => {
      let consumed = state === "consumed";
      const host = makeResendHost({
        chatQueue: [
          {
            id: "first",
            text: "held by gateway",
            createdAt: 1,
            sendAttempts: 1,
            sendRunId: "original",
            sendState: "waiting-reconnect",
            sendFirstAttemptAtMs: Date.now(),
            sessionId: ORIGINAL_SESSION_ID,
          },
          { id: "second", text: "successor", createdAt: 2, sendAttempts: 0 },
        ],
        requestHandlers: {
          "chat.history": () => ({
            ...idleChatHistory(),
            inputReceipts: [
              consumed
                ? { runId: "original", state: "consumed", consumedByEventId: "stored-user" }
                : { runId: "original", state: "pending" },
            ],
          }),
          "chat.send": () => ({ status: "ok", messageSeq: 2 }),
        },
      });
      admitHostQueueItems(host);
      await resumeStoredChatOutboxes(host);
      expect(
        requestCalls(host.request, "chat.send").map(
          ([, params]) => requireRecord(params, "send request").message,
        ),
      ).toEqual(["successor"]);
      if (!consumed) {
        expect(host.chatQueue.map((item) => item.sendRunId)).toEqual(["original"]);
        consumed = true;
        await resumeStoredChatOutboxes(host);
      }
      expect(listStoredChatOutboxes(host)).toEqual([]);
    },
  );

  it("retires a recent attempted message already proved by history without resending", async () => {
    const host = makeResendHost({
      chatQueue: [
        {
          id: "first",
          text: "delivered",
          createdAt: 1,
          sendAttempts: 1,
          sendRunId: "original",
          sendState: "waiting-reconnect",
          sendFirstAttemptAtMs: Date.now(),
          sessionId: ORIGINAL_SESSION_ID,
        },
      ],
      requestHandlers: {
        "chat.history": () => ({
          ...idleChatHistory(),
          messages: [
            {
              role: "user",
              content: "delivered",
              __openclaw: { id: "user", seq: 1, idempotencyKey: "original:user" },
            },
          ],
        }),
      },
    });
    admitHostQueueItems(host);
    await resumeStoredChatOutboxes(host);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
  });
});
