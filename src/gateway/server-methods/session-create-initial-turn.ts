import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { captureAgentTurnPrincipal } from "../agent-turn/principal.js";
import type { CreatedGatewaySession } from "../session-create-service.types.js";
import {
  normalizeRpcAttachmentsToChatAttachments,
  type RpcAttachmentInput,
} from "./attachment-normalize.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { bindGatewayRequestHandlerMutationAuthority } from "./session-mutation-guards.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  TrustedAgentToolCaller,
} from "./types.js";

const loadChatSendInternalEntry = createLazyRuntimeModule(() => import("./chat-send-handler.js"));
const loadChatSendExternalEntry = createLazyRuntimeModule(
  () => import("./chat-send-external-entry.js"),
);

// Dispatch can respond before throwing; creation retains the reply alongside that failure.
export type SessionCreateInitialTurnResult = {
  payload?: object;
  error?: unknown;
  meta?: Record<string, unknown>;
};

export async function dispatchSessionCreateInitialTurn(
  options: GatewayRequestHandlerOptions,
  params: {
    client: GatewayClient | null;
    session: Pick<CreatedGatewaySession, "key" | "agentId">;
    request: Pick<SessionsCreateParams, "timeoutMs" | "mentions">;
    initialTurn: NonNullable<ReturnType<typeof resolveSessionCreateInitialTurn>>;
    initialRunId: string;
    agentCreated: boolean;
    sessionSourceAccepted: boolean;
    toolRequester: TrustedAgentToolCaller | undefined;
    requesterSessionKey: string | undefined;
    assertCurrent: () => void;
    result: SessionCreateInitialTurnResult;
  },
): Promise<void> {
  const {
    client,
    session,
    request,
    initialTurn: { attachments, message },
    initialRunId,
    agentCreated,
    sessionSourceAccepted,
    toolRequester,
    requesterSessionKey,
    assertCurrent,
    result,
  } = params;
  const sendClient =
    sessionSourceAccepted || agentCreated ? captureAgentTurnPrincipal(client) : client;
  if (agentCreated && sendClient && toolRequester) {
    // Creator/access identity stays with the person; their agent wrote the opening message.
    sendClient.internal = {
      ...sendClient.internal,
      senderAttribution: { id: "agent:" + toolRequester.agentId },
    };
  }
  const sendOptions = bindGatewayRequestHandlerMutationAuthority(
    options,
    {
      ...options,
      client: sendClient,
      params: {
        sessionKey: session.key,
        agentId: session.agentId,
        message: message ?? "",
        idempotencyKey: initialRunId,
        ...(agentCreated
          ? {
              systemInputProvenance: {
                kind: "inter_session",
                sourceSessionKey: requesterSessionKey,
                sourceTool: "sessions_create",
              },
              suppressCommandInterpretation: true,
            }
          : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.mentions ? { mentions: request.mentions } : {}),
        ...(attachments ? { attachments } : {}),
      },
      respond: (ok, payload, error, meta) => {
        if (ok && payload && typeof payload === "object") {
          result.payload = payload;
        } else {
          result.error = error;
        }
        result.meta = meta;
      },
    },
    undefined,
  );
  assertCurrent();
  // The initial turn must acquire its own writer, not the requesting session's.
  await runWithoutOwnedSessionTranscriptWrites(async () => {
    if (agentCreated) {
      const { handleTrustedInternalChatSend } = await loadChatSendInternalEntry();
      await handleTrustedInternalChatSend(sendOptions, undefined, { stageCreatedInput: true });
    } else {
      const { handleDirectExternalChatSend } = await loadChatSendExternalEntry();
      await handleDirectExternalChatSend(sendOptions);
    }
  });
}

export function resolveSessionCreateInitialTurn(params: {
  attachments?: unknown[];
  message?: unknown;
  task?: unknown;
}) {
  const message = readNonBlankString(params.task) ?? readNonBlankString(params.message);
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
    params.attachments as RpcAttachmentInput[] | undefined,
  );
  if (params.attachments?.length && !message && normalizedAttachments.length === 0) {
    return null;
  }
  const attachments = normalizedAttachments.length ? normalizedAttachments : undefined;
  return {
    attachments,
    hasInitialTurn: message !== undefined || attachments !== undefined,
    message,
  };
}

export function isFreshChatSendStarted(params: { cached?: boolean; payload: unknown }): boolean {
  if (params.cached) {
    return false;
  }
  const status =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { status?: unknown }).status
      : undefined;
  return status === "started";
}

/** Validate the initial turn against the same child identity used by creation. */
export async function validateSessionCreateInitialMentions(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  agentId: string;
  sessionKey: string;
  message?: string;
  mentions: NonNullable<SessionsCreateParams["mentions"]>;
  visibility: SessionsCreateParams["visibility"];
  runId: string;
}): Promise<ErrorShape | undefined> {
  const { client, context, agentId, sessionKey, message, mentions, visibility, runId } = params;
  const normalization = normalizeChatSendRequest({
    params: {
      sessionKey,
      message: message ?? "",
      mentions,
      idempotencyKey: runId,
    },
    client,
  });
  const normalized = normalization instanceof Promise ? await normalization : normalization;
  if (!normalized.ok) {
    return errorShape(ErrorCodes.INVALID_REQUEST, normalized.error);
  }
  const eligible = await context.mentionInbox?.validateRecipientsAsync(
    client,
    { agentId, ...(visibility ? { visibility } : {}) },
    mentions.map((mention) => mention.profileId),
  );
  if (!eligible?.ok) {
    return (
      eligible?.error ??
      errorShape(ErrorCodes.UNAVAILABLE, "Human mentions are unavailable; reconnect and retry.")
    );
  }
  return undefined;
}
