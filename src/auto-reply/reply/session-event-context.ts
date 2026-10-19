import { channelRouteTargetsMatchExact } from "../../plugin-sdk/channel-route.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { MsgContext } from "../templating.js";
import type { SessionEventEnqueueOptions, SessionEventTarget } from "./session-event-contract.js";
import { setChannelSourceTurnId } from "./source-turn-id.js";

export function buildSessionEventContext(params: {
  agentId: string;
  sessionKey: string;
  text: string;
  options: Pick<SessionEventEnqueueOptions, "source" | "sourceTurnId" | "readmissionAttempt">;
  occurrenceId: string;
  deliveryContext?: DeliveryContext;
  target: SessionEventTarget;
}): MsgContext {
  const { agentId, sessionKey, text, options, occurrenceId, deliveryContext, target } = params;
  const ctx: MsgContext = {
    AgentId: agentId,
    SessionKey: sessionKey,
    Body: text,
    BodyForAgent: text,
    InternalTurnSource: "event",
    BodyForCommands: "",
    CommandBody: "",
    RawBody: "",
    CommandAuthorized: false,
    InputProvenance: { kind: "internal_system", sourceTool: options.source },
    ChatType: channelRouteTargetsMatchExact({
      left: deliveryContext,
      right: target.deliveryContext,
    })
      ? target.chatType
      : undefined,
    Surface: deliveryContext?.channel ?? INTERNAL_MESSAGE_CHANNEL,
    Provider: deliveryContext?.channel ?? INTERNAL_MESSAGE_CHANNEL,
    OriginatingChannel: deliveryContext?.channel,
    OriginatingTo: deliveryContext?.to,
    AccountId: deliveryContext?.accountId,
    MessageThreadId: deliveryContext?.threadId,
    // Inbound dedupe retains an adopted attempt's id; a policy re-admission is a new dispatch.
    MessageSid: options.readmissionAttempt
      ? `${occurrenceId}:readmission-${options.readmissionAttempt}`
      : occurrenceId,
  };
  setChannelSourceTurnId(ctx, options.sourceTurnId);
  return ctx;
}
