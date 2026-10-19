import type { ReplyExpectation } from "../agents/reply-completion.types.js";

type ReplyAccounting = ReturnType<typeof createReplyOperationReplyAccounting>;
const replyAccountingByOperation = new WeakMap<object, ReplyAccounting>();

/** Holds historical accounting for one exact operation; it grants no execution authority. */
export function createReplyOperationReplyAccounting(hasEnded: () => boolean) {
  let acceptedHumanReplyExpectation: Exclude<ReplyExpectation, "optional"> | undefined;
  let hasHostTerminalOwner = false;
  let sourceReplyDelivered = false;
  return {
    get sourceReplyDelivered() {
      return sourceReplyDelivered;
    },
    resetSourceReplyDelivery(this: void) {
      sourceReplyDelivered = false;
    },
    markSourceReplyDelivered(this: void) {
      sourceReplyDelivered = true;
    },
    get acceptedHumanReplyExpectation() {
      return acceptedHumanReplyExpectation;
    },
    recordAcceptedHumanReply(this: void, expectation: ReplyExpectation) {
      if (expectation === "optional") {
        return;
      }
      if (expectation === "result-required" || !acceptedHumanReplyExpectation) {
        acceptedHumanReplyExpectation = expectation;
      }
    },
    get hasHostTerminalOwner() {
      return hasHostTerminalOwner;
    },
    bindHostTerminalOwner(this: void) {
      if (hasEnded()) {
        throw new Error("Cannot bind a terminal owner to a completed reply operation");
      }
      hasHostTerminalOwner = true;
    },
  };
}

/** Index the same accounting object owned by the operation, without acquiring run authority. */
export function bindReplyOperationReplyAccounting(operation: object, accounting: ReplyAccounting) {
  replyAccountingByOperation.set(operation, accounting);
}

/** Historical accounting follows the held operation, never the current slot or a keyed successor. */
export function readReplyOperationReplyAccounting(
  operation: object | undefined,
):
  | Pick<
      ReplyAccounting,
      | "acceptedHumanReplyExpectation"
      | "recordAcceptedHumanReply"
      | "hasHostTerminalOwner"
      | "bindHostTerminalOwner"
    >
  | undefined {
  return operation ? replyAccountingByOperation.get(operation) : undefined;
}
