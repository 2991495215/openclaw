// Tracks delivered native question controls until the Gateway resolves them.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createQuestionChannelRuntime } from "./question-channel-runtime-internal.js";

// Source-loaded plugin SDK chunks and Gateway chunks must share one delivery owner.
// Per-Gateway retirement is separate from the reusable process-lifecycle reset.
const questionChannelRuntime = resolveGlobalSingleton(
  Symbol.for("openclaw.questionChannelRuntime"),
  createQuestionChannelRuntime,
  (runtime) => runtime.clear(),
);

export const handleQuestionChannelRequested = questionChannelRuntime.handleRequested;
export const handleQuestionChannelResolved = questionChannelRuntime.handleResolved;
export const runWithQuestionChannelDeliveries = questionChannelRuntime.runWithDeliveries;
export const registerQuestionChannelDelivery = questionChannelRuntime.registerDelivery;
export const retireQuestionChannelGateway = questionChannelRuntime.retireGateway;
