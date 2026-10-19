import type { ReplyExpectation } from "../agents/reply-completion.js";
import {
  sessionControllerOperationState,
  type ReplyOperation,
  type SessionControllerOperation,
} from "./session-controller.contracts.js";

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

/** Historical accounting follows the held operation, never the current slot or a keyed successor. */
export function readReplyOperationReplyAccounting(
  operation: ReplyOperation | undefined,
):
  | Pick<
      SessionControllerOperation[typeof sessionControllerOperationState],
      | "acceptedHumanReplyExpectation"
      | "recordAcceptedHumanReply"
      | "hasHostTerminalOwner"
      | "bindHostTerminalOwner"
    >
  | undefined {
  return (operation as Partial<SessionControllerOperation> | undefined)?.[
    sessionControllerOperationState
  ];
}
