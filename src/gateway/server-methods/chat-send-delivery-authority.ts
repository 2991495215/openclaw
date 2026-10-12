import {
  getReplyPayloadMetadata,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import { captureWebchatReplyMediaScope } from "./chat-reply-media.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestContext } from "./types.js";

export type ChatSendReplyFinalizationParams = {
  requesterContext?: Parameters<typeof captureWebchatReplyMediaScope>[0]["requesterContext"];
  abortSignal?: AbortSignal;
  accountId: string | undefined;
  context: GatewayRequestContext;
  terminalEntry: Pick<ChatAbortControllerEntry, "terminalOutcomeObserved"> | undefined;
  emitFirstAssistantServerTiming: () => void;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
};

export async function createChatSendReplyFinalizationAuthority(
  params: ChatSendReplyFinalizationParams & { isCurrent?: () => boolean },
  payloads: readonly ReplyPayload[],
  onUnauthorized?: () => void,
) {
  const { cfg, sessionKey, agentId, sessionLoadOptions } = params.session;
  const sources = new Map<string, Awaited<ReturnType<typeof prepareSessionMutationFacts>>>();
  try {
    for (const payload of payloads) {
      const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
      if (!authority) {
        continue;
      }
      const sourceAgentId = authority.agentId ?? agentId;
      const key = `${sourceAgentId}\0${authority.sessionKey}`;
      if (!sources.has(key)) {
        sources.set(
          key,
          await prepareSessionMutationFacts({
            cfg,
            sessionKey: authority.sessionKey,
            agentId: sourceAgentId,
            allowMissing: true,
          }),
        );
      }
    }
  } catch (error) {
    for (const source of sources.values()) {
      source.release();
    }
    throw error;
  }
  const deliveryAuthorized = () =>
    (!params.isCurrent || params.isCurrent()) &&
    payloads.every((payload) => {
      const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
      if (!authority) {
        return true;
      }
      const source = sources.get(`${authority.agentId ?? agentId}\0${authority.sessionKey}`)!;
      return isReplyPayloadSessionWriterDeliveryAuthorized(
        payload,
        source.readCurrent(cfg).target?.entry,
      );
    });
  return {
    [Symbol.dispose]: () => {
      for (const source of sources.values()) {
        source.release();
      }
    },
    deliveryAuthorized,
    authorizeDelivery: (stage: string) => {
      if (deliveryAuthorized()) {
        return true;
      }
      params.context.logGateway.warn(
        `webchat settled final reply skipped: session writer changed before ${stage}`,
      );
      onUnauthorized?.();
      return false;
    },
    captureMediaScope: () =>
      captureWebchatReplyMediaScope({
        cfg,
        sessionKey,
        agentId,
        sessionLoadOptions,
        requesterContext: params.requesterContext,
        accountId: params.accountId,
        assertCurrent: () => {
          if (!deliveryAuthorized()) {
            throw new Error("Chat media delivery is no longer authorized.");
          }
        },
      }),
  };
}
