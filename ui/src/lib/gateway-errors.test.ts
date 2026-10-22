// @vitest-environment node
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  isMissingOperatorReadScopeError,
  isRetryableGatewayReadError,
  isWizardNotFoundError,
  isSetupAdmissionBusyError,
} from "./gateway-errors.ts";

function requestError(code: string, message: string, details?: Record<string, unknown>) {
  return new GatewayRequestError({ code, message, details });
}
function missingScope(scope: string, message = `missing scope: ${scope}`) {
  return requestError("FORBIDDEN", message, {
    code: "MISSING_SCOPE",
    missingScope: scope,
    requiredScopes: [scope],
  });
}

describe("gateway error helpers", () => {
  it("retries only typed transient failures for the requested read", () => {
    const method = "sessions.usage";
    const deadline = new GatewayProtocolRequestTimeoutError({
      method,
      timeoutMs: 30_000,
      requestSent: true,
    });
    expect(isRetryableGatewayReadError(deadline, method)).toBe(true);
    expect(isRetryableGatewayReadError(deadline, "sessions.diff")).toBe(false);
    expect(
      isRetryableGatewayReadError(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "busy",
          retryable: true,
          details: { method },
        }),
        method,
      ),
    ).toBe(true);
    for (const error of [
      new GatewayRequestError({ code: "UNAVAILABLE", message: "permanent" }),
      new GatewayRequestError({ code: "FORBIDDEN", message: "denied", retryable: true }),
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "invalid", retryable: true }),
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "another read",
        retryable: true,
        details: { method: "sessions.diff" },
      }),
      new TypeError("programming failure"),
      new Error("unknown failure"),
    ]) {
      expect(isRetryableGatewayReadError(error, method)).toBe(false);
    }
  });

  it.each([
    [isWizardNotFoundError, "INVALID_REQUEST", "WIZARD_NOT_FOUND"],
    [isSetupAdmissionBusyError, "UNAVAILABLE", "SETUP_ADMISSION_BUSY"],
  ] as const)(
    "classifies structured %s %s %s without parsing copy",
    (classify, code, detailCode) => {
      const details = { code: detailCode };
      expect(classify(requestError(code, "localized or changed public copy", details))).toBe(true);
      expect(classify({ gatewayCode: code, details })).toBe(true);
    },
  );

  it.each([
    [isWizardNotFoundError, "INVALID_REQUEST", "WIZARD_NOT_FOUND", "UNAVAILABLE"],
    [isSetupAdmissionBusyError, "UNAVAILABLE", "SETUP_ADMISSION_BUSY", "INVALID_REQUEST"],
  ] as const)("rejects unrelated %s %s %s %s errors", (classify, code, detailCode, wrongCode) => {
    expect(
      classify({
        gatewayCode: wrongCode,
        details: { code: detailCode },
      }),
    ).toBe(false);
    expect(
      classify({
        gatewayCode: code,
        details: { code: "UNKNOWN_AGENT_ID" },
      }),
    ).toBe(false);
    expect(classify({ gatewayCode: code, message: "wizard not found" })).toBe(false);
    for (const details of [null, detailCode, [], { code: 42 }]) {
      expect(classify({ gatewayCode: code, details })).toBe(false);
    }
  });

  it("classifies structured read-scope failures without message parsing", () => {
    expect(
      isMissingOperatorReadScopeError(missingScope("operator.read", "permission denied")),
    ).toBe(true);
  });

  it("uses the shared client's missing-scope message reader", () => {
    expect(
      isMissingOperatorReadScopeError(
        requestError("INVALID_REQUEST", "missing scope: operator.read"),
      ),
    ).toBe(true);
  });

  it("does not treat connect authorization errors as missing read scope", () => {
    expect(
      isMissingOperatorReadScopeError(
        requestError("INVALID_REQUEST", "unauthorized", { code: "AUTH_UNAUTHORIZED" }),
      ),
    ).toBe(false);
  });

  it("does not confuse another missing scope with operator.read", () => {
    expect(isMissingOperatorReadScopeError(missingScope("operator.questions"))).toBe(false);
  });
});
