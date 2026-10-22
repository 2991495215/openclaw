import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
} from "../../config/sessions/session-accessor.js";
import { useUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
import { installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();
const prepareProfiles = useUserProfileCatalogForTest();
beforeEach(() => prepareProfiles());

it.each(["cancelled", "interrupted"] as const)(
  "releases only cancelled question custody (%s)",
  async (disposition) => {
    await using fixture = await createFixture({ preserveContent: true });
    const source = await appendTranscriptMessage(fixture.scope, {
      message: {
        role: "assistant",
        content: "Which audience?",
        timestamp: 2,
        openclawAsyncDelivery: { itemId: "audience", questions: [{ title: "Which audience?" }] },
      },
    });
    const params = {
      ...fixture.params,
      replyToId: source!.messageId,
      asyncQuestionItemId: "audience",
      message: "Engineers",
    };
    expect((await fixture.send(vi.fn<RespondFn>(), undefined, params)).mock.calls[0]?.[0]).toBe(
      true,
    );
    const recorder = await fixture.dispatchedRecorder;
    recorder.finishPendingInput?.(disposition);
    await recorder.waitForPendingInputSettlement?.();
    expect((await listSessionPendingInputs(fixture.scope)).items[0]?.state).toBe(disposition);
    const next = await fixture.send(vi.fn<RespondFn>(), undefined, {
      ...params,
      idempotencyKey: "after-settlement",
      message: "Everyone",
    });
    expect(next.mock.calls[0]?.[0]).toBe(disposition === "cancelled");
    if (disposition === "interrupted") {
      expect(next.mock.calls[0]?.[2]).toMatchObject({
        details: { reason: "async-question-already-answered" },
      });
    }
  },
);

it("atomically accepts only one of two concurrent viewer answers", async () => {
  await using fixture = await createFixture({ preserveContent: true });
  const source = await appendTranscriptMessage(fixture.scope, {
    message: {
      role: "assistant",
      content: "Which audience?",
      timestamp: 2,
      openclawAsyncDelivery: { itemId: "audience", questions: [{ title: "Which audience?" }] },
    },
  });
  const replies = await Promise.all(
    ["Engineers", "Everyone"].map((answer, index) =>
      fixture.send(vi.fn<RespondFn>(), undefined, {
        ...fixture.params,
        idempotencyKey: "concurrent-" + index,
        replyToId: source!.messageId,
        asyncQuestionItemId: "audience",
        message: answer,
      }),
    ),
  );
  expect(replies.filter((reply) => reply.mock.calls[0]?.[0] === true)).toHaveLength(1);
  expect((await listSessionPendingInputs(fixture.scope)).total).toBe(1);
  expect(
    replies.find((reply) => reply.mock.calls[0]?.[0] === false)?.mock.calls[0]?.[2],
  ).toMatchObject({ details: { reason: "async-question-already-answered" } });
});

it.each([true, false])("admits one answer across stale viewers (queued=%s)", async (active) => {
  await using fixture = await createFixture({ active, preserveContent: true });
  const source = await appendTranscriptMessage(fixture.scope, {
    message: {
      role: "assistant",
      content: "Which audience?",
      timestamp: 2,
      openclawAsyncDelivery: { itemId: "audience", questions: [{ title: "Which audience?" }] },
    },
  });
  expect(source?.messageId).toBeTruthy();
  const first = {
    ...fixture.params,
    replyToId: source!.messageId,
    asyncQuestionItemId: "audience",
    message: "> Which audience?\n\nEngineers",
  };
  const invalid = await fixture.send(vi.fn<RespondFn>(), undefined, {
    ...first,
    replyToId: "another-session-question",
    idempotencyKey: "invalid-question",
  });
  expect(invalid.mock.calls[0]?.[0]).toBe(false);
  expect((await listSessionPendingInputs(fixture.scope)).total).toBe(0);
  const admitted = await fixture.send(vi.fn<RespondFn>(), undefined, first);
  expect(admitted).toHaveBeenCalledWith(true, expect.anything(), undefined, expect.anything());
  const retry = await fixture.send(vi.fn<RespondFn>(), undefined, first);
  expect(retry).toHaveBeenCalledWith(true, expect.anything(), undefined, expect.anything());
  fixture.client.connId = "another-authorized-viewer";
  for (const [index, message] of [first.message, "> Which audience?\n\nEveryone"].entries()) {
    const second = await fixture.send(vi.fn<RespondFn>(), undefined, {
      ...first,
      idempotencyKey: "stale-answer-" + index,
      message,
    });
    expect(second).toHaveBeenCalledWith(
      false,
      expect.anything(),
      expect.objectContaining({ details: { reason: "async-question-already-answered" } }),
      expect.anything(),
    );
  }
  const pending = await listSessionPendingInputs(fixture.scope);
  const transcript = fixture.readTranscript();
  const accepted = [
    ...pending.items.map((input) => input.message),
    ...transcript.flatMap((event) => {
      const record = asOptionalRecord(event);
      return record?.type === "message" ? [record.message] : [];
    }),
  ];
  expect(
    accepted.filter((message) => {
      const record = asOptionalRecord(message);
      return (
        record?.role === "user" &&
        asOptionalRecord(record["__openclaw"])?.asyncQuestionItemId === "audience"
      );
    }),
  ).toHaveLength(1);
  const { asyncQuestionItemId: _question, ...ordinary } = first;
  const correction = await fixture.send(vi.fn<RespondFn>(), undefined, {
    ...ordinary,
    idempotencyKey: "manual-correction",
    message: "Actually, use Everyone.",
  });
  expect(correction.mock.calls[0]?.[0]).toBe(true);
  const nextSource = await appendTranscriptMessage(fixture.scope, {
    message: {
      role: "assistant",
      content: "Which audience?",
      timestamp: 3,
      openclawAsyncDelivery: { itemId: "next-audience", questions: [{ title: "Which audience?" }] },
    },
  });
  const next = await fixture.send(vi.fn<RespondFn>(), undefined, {
    ...first,
    replyToId: nextSource!.messageId,
    asyncQuestionItemId: "next-audience",
    idempotencyKey: "new-question-answer",
  });
  expect(next.mock.calls[0]?.[0]).toBe(true);
});
