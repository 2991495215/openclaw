import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type {
  ModelCatalogScope,
  ModelsListResult,
  ModelsSnapshotEvent,
  ModelsSnapshotErrorEvent,
  SessionsResolveResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../../agents/agent-scope-config.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { resolveGatewayAgentSelectionState } from "../../agent-list.js";
import type { createGatewayAuthenticatedRequestDispatcher } from "./authenticated-request-dispatch.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

/** Bootstrap uses ordinary request admission and delivery authority, including deferred identity. */
export async function publishConnectModelCatalog(
  handler: GatewayWsMessageHandlerParams,
  dispatcher: ReturnType<typeof createGatewayAuthenticatedRequestDispatcher>,
): Promise<void> {
  const client = handler.getClient();
  const requestedScope = client?.connect.modelCatalog;
  if (
    client?.connect.client.id !== GATEWAY_CLIENT_IDS.CONTROL_UI ||
    !hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.MODEL_CATALOG_SNAPSHOT) ||
    !requestedScope
  ) {
    return;
  }
  const fail = (
    error: { code: string; message: string } = {
      code: "UNAVAILABLE",
      message: "Model catalog unavailable",
    },
  ) =>
    handler.send({
      type: "event",
      event: "models.snapshot.error",
      payload: { target: requestedScope, error } satisfies ModelsSnapshotErrorEvent,
    });
  try {
    let scope: ModelCatalogScope;
    if ("shortId" in requestedScope) {
      const resolveRequest = {
        type: "req" as const,
        id: `catalog-session:${handler.connId}`,
        method: "sessions.resolve",
        params: requestedScope,
      };
      const resolution: { value?: SessionsResolveResult; failed?: boolean } = {};
      await dispatcher.dispatch(
        resolveRequest,
        client,
        Buffer.byteLength(JSON.stringify(resolveRequest)),
        undefined,
        (frame) => {
          if (!frame.ok) {
            resolution.failed = true;
            return fail(frame.error);
          }
          // SAFETY: The registered sessions.resolve handler owns this response contract.
          resolution.value = frame.payload as SessionsResolveResult;
          return { kind: "sent" };
        },
      );
      if (resolution.failed) {
        return;
      }
      const resolved = resolution.value;
      if (!resolved?.ok) {
        fail({ code: "UNAVAILABLE", message: "Model catalog session unavailable" });
        return;
      }
      scope = { agentId: resolved.agentId, sessionKey: resolved.key };
    } else if (requestedScope.sessionKey) {
      scope = requestedScope;
    } else {
      const cfg = handler.buildRequestContext().getRuntimeConfig();
      const requestedAgentId = requestedScope.agentId
        ? normalizeAgentId(requestedScope.agentId)
        : undefined;
      scope = {
        agentId:
          requestedAgentId && listAgentIds(cfg).includes(requestedAgentId)
            ? requestedAgentId
            : resolveGatewayAgentSelectionState(cfg).defaultId,
      };
    }
    const request = {
      type: "req" as const,
      id: `catalog:${handler.connId}`,
      method: "models.list",
      params: { ...scope, view: "configured" },
    };
    return await dispatcher.dispatch(
      request,
      client,
      Buffer.byteLength(JSON.stringify(request)),
      undefined,
      (frame) => {
        if (!frame.ok) {
          return fail(frame.error);
        }
        return handler.send({
          type: "event",
          event: "models.snapshot",
          payload: {
            target: requestedScope,
            scope,
            // SAFETY: This response comes only from the registered models.list handler.
            catalog: frame.payload as ModelsListResult,
          } satisfies ModelsSnapshotEvent,
        });
      },
    );
  } catch (error) {
    // Release readers on unexpected failures too, but preserve the defect for the caller's log.
    fail();
    throw error;
  }
}
