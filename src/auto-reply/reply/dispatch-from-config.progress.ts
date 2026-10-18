import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../reply-payload.js";
import { createDispatchCommentaryProgress } from "./dispatch-from-config.commentary.js";
import {
  hasExecApprovalPayload,
  requiresDurableToolResultDelivery,
} from "./dispatch-from-config.payloads.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";

/** Owns progress visibility, commentary ordering, and the cutoff after final delivery starts. */
export function createDispatchProgress(
  state: Pick<
    PrepareDispatchOperationReadyState,
    | "params"
    | "ctx"
    | "sendPolicyDenied"
    | "suppressDelivery"
    | "suppressAutomaticSourceDelivery"
    | "sourceReplyDeliveryMode"
    | "shouldEmitVerboseProgress"
    | "shouldEmitVerboseProgressAsync"
    | "shouldEmitFullVerboseProgressAsync"
    | "isDispatchOperationAborted"
    | "assertProgressCurrent"
    | "shouldRouteToOriginating"
    | "sendPayloadAsync"
    | "markInboundDedupeReplayUnsafe"
    | "turnLedger"
  >,
) {
  const {
    params,
    ctx,
    shouldEmitVerboseProgressAsync,
    shouldRouteToOriginating,
    sendPayloadAsync,
    markInboundDedupeReplayUnsafe,
    turnLedger,
  } = state;
  const shouldSuppressProgressDelivery = async () =>
    state.sendPolicyDenied ||
    (state.suppressDelivery && !(await shouldDeliverVerboseProgressDespiteSourceSuppression()));
  // The released reply_dispatch getter retains its synchronous contract.
  const shouldSendToolSummaries = () =>
    params.replyOptions?.suppressToolProgressMessages !== true && state.shouldEmitVerboseProgress();
  const shouldSendToolSummariesAsync = async () =>
    params.replyOptions?.suppressToolProgressMessages !== true &&
    (await shouldEmitVerboseProgressAsync());
  const allowsVerboseProgressDespiteSourceSuppression = () =>
    state.suppressAutomaticSourceDelivery &&
    state.sourceReplyDeliveryMode === "message_tool_only" &&
    ctx.InboundEventKind !== "room_event" &&
    !state.sendPolicyDenied;
  const shouldDeliverVerboseProgressDespiteSourceSuppression = async () =>
    allowsVerboseProgressDespiteSourceSuppression() && (await shouldSendToolSummariesAsync());
  const shouldSuppressProgressDeliverySync = () =>
    state.sendPolicyDenied ||
    (state.suppressDelivery &&
      !(allowsVerboseProgressDespiteSourceSuppression() && shouldSendToolSummaries()));
  const shouldDeliverForcedToolProgressDespiteSourceSuppression = () =>
    allowsVerboseProgressDespiteSourceSuppression() &&
    params.replyOptions?.forceToolResultProgress === true;
  let finalReplyDeliveryStarted = false;
  const shouldSuppressLateTextOnlyToolProgress = (payload: ReplyPayload) =>
    finalReplyDeliveryStarted && !requiresDurableToolResultDelivery(payload);
  const { flushPendingCommentaryProgress, noteCommentaryProgress } =
    createDispatchCommentaryProgress({
      shouldSendToolSummaries: shouldSendToolSummariesAsync,
      shouldSuppressDelivery: shouldSuppressProgressDelivery,
      isAborted: () => state.isDispatchOperationAborted(),
      isFinalDeliveryStarted: () => finalReplyDeliveryStarted,
      assertCurrent: () => state.assertProgressCurrent(),
      send: shouldRouteToOriginating
        ? sendPayloadAsync
        : (payload) => {
            markInboundDedupeReplayUnsafe();
            turnLedger.sendQueued("tool", payload);
          },
    });
  const shouldSuppressMessageToolOnlyTextErrorProgress = async (payload: ReplyPayload) => {
    if (
      state.sourceReplyDeliveryMode !== "message_tool_only" ||
      (await state.shouldEmitFullVerboseProgressAsync()) ||
      payload.isError !== true
    ) {
      return false;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    return !reply.hasMedia && !hasExecApprovalPayload(payload);
  };
  return {
    shouldSuppressProgressDelivery,
    shouldSuppressProgressDeliverySync,
    shouldSendToolSummaries,
    shouldSendToolSummariesAsync,
    shouldDeliverVerboseProgressDespiteSourceSuppression,
    shouldDeliverForcedToolProgressDespiteSourceSuppression,
    shouldSuppressLateTextOnlyToolProgress,
    flushPendingCommentaryProgress,
    noteCommentaryProgress,
    shouldSuppressMessageToolOnlyTextErrorProgress,
    markFinalReplyDeliveryStarted: () => {
      finalReplyDeliveryStarted = true;
    },
  };
}
