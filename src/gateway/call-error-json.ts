import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import {
  isGatewayClientRequestError,
  isGatewayCredentialsRequiredError,
  isGatewayExplicitAuthRequiredError,
} from "./call.js";
import { projectGatewayConnectionDetailsForDiagnostics } from "./connection-details.js";
import { isGatewaySecretRefUnavailableError } from "./credentials.js";
import {
  firstGatewayErrorLine,
  isGatewayTransportError,
  type GatewayTransportErrorKind,
} from "./transport-error.js";

type GatewayTransportErrorJson = {
  ok: false;
  error: {
    type: "gateway_transport_error";
    kind: GatewayTransportErrorKind;
    message: string;
    code?: number;
    reason?: string;
    timeoutMs?: number;
  };
  gateway: {
    url: string;
    urlSource: string;
    bindDetail?: string;
    remoteFallbackNote?: string;
  };
};

type GatewayClientRequestErrorJson = {
  ok: false;
  error: {
    type: "gateway_request_error";
    code: string;
    message: string;
    details?: unknown;
    retryable: boolean;
    retryAfterMs?: number;
  };
};

type GatewayAuthErrorJson = {
  ok: false;
  error: {
    type: "gateway_credentials_required";
    message: string;
  };
};

export function formatGatewayTransportErrorJson(value: unknown): GatewayTransportErrorJson | null {
  if (!isGatewayTransportError(value)) {
    return null;
  }
  const connectionDetails = projectGatewayConnectionDetailsForDiagnostics(value.connectionDetails);
  return {
    ok: false,
    error: {
      type: "gateway_transport_error",
      kind: value.kind,
      // The message embeds the remote-controlled close reason, which can echo a
      // credential-bearing URL; redact both before they reach CLI JSON output.
      message: redactSensitiveUrlLikeString(firstGatewayErrorLine(value.message)),
      ...(value.code !== undefined ? { code: value.code } : {}),
      ...(value.reason !== undefined ? { reason: redactSensitiveUrlLikeString(value.reason) } : {}),
      ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
    },
    gateway: {
      url: connectionDetails.url,
      urlSource: connectionDetails.urlSource,
      ...(connectionDetails.bindDetail ? { bindDetail: connectionDetails.bindDetail } : {}),
      ...(connectionDetails.remoteFallbackNote
        ? { remoteFallbackNote: connectionDetails.remoteFallbackNote }
        : {}),
    },
  };
}

/** Preserve machine-readable output for auth failures raised before transport startup. */
export function formatGatewayCallErrorJson(
  value: unknown,
): GatewayAuthErrorJson | GatewayClientRequestErrorJson | GatewayTransportErrorJson | null {
  if (
    isGatewayCredentialsRequiredError(value) ||
    isGatewayExplicitAuthRequiredError(value) ||
    isGatewaySecretRefUnavailableError(value)
  ) {
    return {
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: value.message,
      },
    };
  }
  if (isGatewayClientRequestError(value)) {
    return {
      ok: false,
      error: {
        type: "gateway_request_error",
        code: value.gatewayCode,
        message: value.message,
        ...(value.details !== undefined ? { details: value.details } : {}),
        retryable: value.retryable,
        ...(value.retryAfterMs !== undefined ? { retryAfterMs: value.retryAfterMs } : {}),
      },
    };
  }
  return formatGatewayTransportErrorJson(value);
}
