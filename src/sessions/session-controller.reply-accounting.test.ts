import { afterEach, expect, it } from "vitest";
import {
  resolveReplyCompletion,
  resolveReplyExpectation,
  shouldDeliverMissingReplyNotice,
} from "../agents/reply-completion.js";
import { createReplyOperation } from "./session-controller.operation.js";
import { readReplyOperationReplyAccounting } from "./session-controller.reply-accounting.js";
import { readSessionControllerOperationState } from "./session-controller.state.js";
import { testing } from "./session-controller.test-support.js";

afterEach(() => testing.resetSessionControllerForTest());
function owner(suffix = "original") {
  const operation = createReplyOperation({
    sessionKey: "agent:main:reply-accounting",
    sessionId: suffix,
    resetTriggered: false,
  });
  const accounting = readReplyOperationReplyAccounting(operation);
  if (!accounting) {
    throw new Error("Expected private reply accounting owner");
  }
  return { operation, accounting };
}
it("keeps host terminal eligibility on the exact private owner", () => {
  const { operation, accounting } = owner();
  expect(accounting.hasHostTerminalOwner).toBe(false);
  accounting.bindHostTerminalOwner();
  expect(accounting.hasHostTerminalOwner).toBe(true);
  operation.complete();
  expect(readSessionControllerOperationState(operation)).toBeUndefined();
  expect(readReplyOperationReplyAccounting(operation)?.hasHostTerminalOwner).toBe(true);
  expect(() => accounting.bindHostTerminalOwner()).toThrow("Cannot bind a terminal owner");
});
it("records an accepted obligation monotonically without treating optional input as a human obligation", () => {
  const { accounting } = owner();
  accounting.recordAcceptedHumanReply("optional");
  expect(accounting.acceptedHumanReplyExpectation).toBeUndefined();
  accounting.recordAcceptedHumanReply("required");
  accounting.recordAcceptedHumanReply("optional");
  accounting.recordAcceptedHumanReply("required");
  expect(accounting.acceptedHumanReplyExpectation).toBe("required");
  accounting.recordAcceptedHumanReply("result-required");
  accounting.recordAcceptedHumanReply("required");
  accounting.recordAcceptedHumanReply("optional");
  expect(accounting.acceptedHumanReplyExpectation).toBe("result-required");
});
it("retains historical accounting after retirement and never transfers a late ACK to a successor", () => {
  const original = owner();
  original.accounting.bindHostTerminalOwner();
  original.operation.complete();
  const successor = owner("successor");
  original.accounting.recordAcceptedHumanReply("result-required");
  expect(readReplyOperationReplyAccounting(original.operation)?.acceptedHumanReplyExpectation).toBe(
    "result-required",
  );
  expect(successor.accounting.acceptedHumanReplyExpectation).toBeUndefined();
  expect(successor.accounting.hasHostTerminalOwner).toBe(false);
  expect(successor.operation.abortSignal.aborted).toBe(false);
});
it.each(["required", "result-required"] as const)(
  "re-reads %s accepted accounting through a copied terminal input",
  (expectation) => {
    const { operation, accounting } = owner();
    const params = {
      replyOperation: operation,
      terminalReplyExpectation: "optional" as const,
      inputProvenance: { kind: "internal_system" as const, sourceTool: "plugin" },
      trigger: "cron" as const,
    };
    const retry = { ...params };
    expect(resolveReplyExpectation(retry)).toBe("optional");
    expect(shouldDeliverMissingReplyNotice(retry)).toBe(false);
    accounting.recordAcceptedHumanReply(expectation);
    operation.complete();
    expect(resolveReplyExpectation(params)).toBe(expectation);
    expect(resolveReplyExpectation(retry)).toBe(expectation);
    expect(shouldDeliverMissingReplyNotice(retry)).toBe(true);
    expect(resolveReplyCompletion(resolveReplyExpectation(retry), "empty")).toMatchObject({
      expectation,
      outcome: "missing",
    });
    expect(resolveReplyCompletion(resolveReplyExpectation(retry), "pending")).toMatchObject({
      expectation,
      outcome: "pending",
    });
    expect(resolveReplyCompletion(resolveReplyExpectation(retry), "delivered")).toMatchObject({
      expectation,
      outcome: "delivered",
    });
  },
);
it("keeps initial result-required stronger than accepted required and does not invent delivery", () => {
  const { operation, accounting } = owner();
  accounting.recordAcceptedHumanReply("required");
  const params = {
    replyOperation: operation,
    terminalReplyExpectation: "result-required" as const,
  };
  expect(resolveReplyExpectation(params)).toBe("result-required");
  expect(resolveReplyCompletion(resolveReplyExpectation(params), "silent").outcome).toBe("missing");
  expect(resolveReplyCompletion(resolveReplyExpectation(params), "blocked").outcome).toBe(
    "blocked",
  );
});
it("preserves old no-operation and ordinary background notice semantics", () => {
  expect(resolveReplyExpectation({ terminalReplyExpectation: "optional" })).toBe("optional");
  expect(
    shouldDeliverMissingReplyNotice({
      terminalReplyExpectation: "required",
      inputProvenance: { kind: "internal_system", sourceTool: "plugin" },
    }),
  ).toBe(false);
  expect(readReplyOperationReplyAccounting(undefined)).toBeUndefined();
});

it("does not promote merely because the host terminal owner is bound", () => {
  const { operation, accounting } = owner();
  accounting.bindHostTerminalOwner();
  expect(accounting.acceptedHumanReplyExpectation).toBeUndefined();
  expect(
    resolveReplyExpectation({ replyOperation: operation, terminalReplyExpectation: "optional" }),
  ).toBe("optional");
  expect(
    shouldDeliverMissingReplyNotice({
      replyOperation: operation,
      terminalReplyExpectation: "optional",
    }),
  ).toBe(false);
});
