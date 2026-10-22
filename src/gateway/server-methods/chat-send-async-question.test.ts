import assert from "node:assert/strict";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { discardSessionPendingInput } from "../../config/sessions/session-pending-input-withdrawal.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { useUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
import { installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();
const prepareProfiles = useUserProfileCatalogForTest();
beforeEach(() => prepareProfiles());

async function appendAudienceQuestion(
  scope: Parameters<typeof appendTranscriptMessage>[0],
  itemId = "audience",
  eventId?: string,
) {
  const source = await appendTranscriptMessage(scope, {
    eventId,
    message: {
      role: "assistant",
      content: "Which audience?",
      timestamp: 2,
      openclawAsyncDelivery: { itemId, questions: [{ title: "Which audience?" }] },
    },
  });
  assert(source, "Expected a persisted question");
  return source;
}

// These answer bytes were captured from openclaw@2026.10.6's published storage
// producer (fe06181dc5ecc01cf8904abbfc26925925efefbc). No async answer ID existed.
// The separate release rehearsal migrates its real v25 database through Doctor's
// current maintenance owner; this bounded regression keeps that legacy JSON contract.
it.each(["queued", "saved"] as const)(
  "keeps legacy %s answer bytes authoritative after SQLite reopens",
  async (kind) => {
    await using fixture = await createFixture({ preserveContent: true });
    const questionId = "legacy-question-" + kind;
    await appendAudienceQuestion(fixture.scope, "legacy-" + kind, questionId);
    const runId = "legacy-answer-" + kind;
    const message = {
      role: "user" as const,
      content: "> Which audience?\n\nEngineers",
      timestamp: 3,
      idempotencyKey: runId + ":user",
      __openclaw: { replyToId: questionId },
    };
    if (kind === "queued") {
      const receipt = await stageSessionPendingInput(fixture.scope, {
        runId,
        message,
        assertCurrent() {},
      });
      assert(receipt, "Expected accepted legacy custody");
      receipt.finish("interrupted");
      await receipt.settled?.();
    } else {
      await appendTranscriptMessage(fixture.scope, { message });
    }
    const original = fixture.readTranscript();
    await closeOpenClawAgentDatabaseByPathAsync(
      resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteScope(fixture.scope))),
      fixture.scope.agentId,
    );
    const params = {
      ...fixture.params,
      idempotencyKey: "legacy-duplicate",
      message: "> Which audience?\n\nEveryone",
      replyToId: questionId,
      asyncQuestionItemId: "legacy-" + kind,
    };
    const duplicate = await fixture.send(vi.fn<RespondFn>(), undefined, params);
    expect(duplicate.mock.calls[0]?.[2]).toMatchObject({
      details: { reason: "async-question-already-answered" },
    });
    expect(fixture.readTranscript()).toEqual(original);
    if (kind === "queued") {
      expect((await listSessionPendingInputs(fixture.scope)).items[0]?.message).toEqual(message);
      expect(await discardSessionPendingInput(fixture.scope, runId, () => {})).toBe(true);
      const replacement = await fixture.send(vi.fn<RespondFn>(), undefined, {
        ...params,
        idempotencyKey: "legacy-replacement",
      });
      expect(replacement.mock.calls[0]?.[0]).toBe(true);
    }
  },
);

it.each(["cancelled", "interrupted"] as const)(
  "releases only cancelled question custody (%s)",
  async (disposition) => {
    await using fixture = await createFixture({ preserveContent: true });
    const source = await appendAudienceQuestion(fixture.scope);
    const params = {
      ...fixture.params,
      replyToId: source.messageId,
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
  const source = await appendAudienceQuestion(fixture.scope);
  const replies = await Promise.all(
    ["Engineers", "Everyone"].map((answer, index) =>
      fixture.send(vi.fn<RespondFn>(), undefined, {
        ...fixture.params,
        idempotencyKey: "concurrent-" + index,
        replyToId: source.messageId,
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
  const source = await appendAudienceQuestion(fixture.scope);
  const first = {
    ...fixture.params,
    replyToId: source.messageId,
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
  const nextSource = await appendAudienceQuestion(fixture.scope, "next-audience");
  const next = await fixture.send(vi.fn<RespondFn>(), undefined, {
    ...first,
    replyToId: nextSource.messageId,
    asyncQuestionItemId: "next-audience",
    idempotencyKey: "new-question-answer",
  });
  expect(next.mock.calls[0]?.[0]).toBe(true);
});
