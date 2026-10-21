// Loads the generated host environment security policy JSON for JS consumers.
import HOST_ENV_SECURITY_POLICY_JSON from "./host-env-security-policy.json" with { type: "json" };

function sortUniqueUppercase(values) {
  return Object.freeze(
    Array.from(new Set(values.map((value) => value.toUpperCase()))).toSorted((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

const blockedEverywhereKeys = HOST_ENV_SECURITY_POLICY_JSON.blockedEverywhereKeys ?? [];
const blockedOverrideOnlyKeys = HOST_ENV_SECURITY_POLICY_JSON.blockedOverrideOnlyKeys ?? [];
const allowedInheritedOverrideOnlyKeys =
  HOST_ENV_SECURITY_POLICY_JSON.allowedInheritedOverrideOnlyKeys ?? [];
const allowedInheritedOverrideOnlyUpper = new Set(
  allowedInheritedOverrideOnlyKeys.map((value) => value.toUpperCase()),
);
const blockedPrefixes = HOST_ENV_SECURITY_POLICY_JSON.blockedPrefixes ?? [];
const blockedOverridePrefixes = HOST_ENV_SECURITY_POLICY_JSON.blockedOverridePrefixes ?? [];
const blockedInheritedPrefixes =
  HOST_ENV_SECURITY_POLICY_JSON.blockedInheritedPrefixes ?? blockedPrefixes;

/**
 * Process-wide host environment security policy derived from generated JSON.
 */
export const HOST_ENV_SECURITY_POLICY = Object.freeze({
  blockedEverywhereKeys: Object.freeze(blockedEverywhereKeys),
  blockedOverrideOnlyKeys: Object.freeze(blockedOverrideOnlyKeys),
  allowedInheritedOverrideOnlyKeys: Object.freeze(allowedInheritedOverrideOnlyKeys),
  blockedInheritedKeys: sortUniqueUppercase([
    ...blockedEverywhereKeys,
    ...blockedOverrideOnlyKeys.filter(
      (value) => !allowedInheritedOverrideOnlyUpper.has(value.toUpperCase()),
    ),
  ]),
  blockedInheritedPrefixes: sortUniqueUppercase(blockedInheritedPrefixes),
  blockedPrefixes: sortUniqueUppercase(blockedPrefixes),
  blockedOverridePrefixes: sortUniqueUppercase(blockedOverridePrefixes),
  blockedKeys: sortUniqueUppercase(blockedEverywhereKeys),
  blockedOverrideKeys: sortUniqueUppercase(blockedOverrideOnlyKeys),
});
