import { isNonEmptyString, isRecord } from "./shared.js";
import type { SecretTargetExpected } from "./target-registry-types.js";

export function isExpectedResolvedSecretValue(
  value: unknown,
  expected: SecretTargetExpected,
): boolean {
  return isNonEmptyString(value) || (expected !== "string" && isRecord(value));
}

export function hasConfiguredPlaintextSecretValue(
  value: unknown,
  expected: SecretTargetExpected,
): boolean {
  return (
    isNonEmptyString(value) ||
    (expected !== "string" && isRecord(value) && Object.keys(value).length > 0)
  );
}

export function assertExpectedResolvedSecretValue(params: {
  value: unknown;
  expected: SecretTargetExpected;
  errorMessage: string;
}): void {
  if (!isExpectedResolvedSecretValue(params.value, params.expected)) {
    throw new Error(params.errorMessage);
  }
}
