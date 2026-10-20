import { expect, it } from "vitest";
import { decodeProviderUsageAdminToken } from "./provider-usage.admin.js";

it.each([
  ['admin:{"token":" fixture-token "}', "fixture-token"],
  ['admin:{"token":" "}', undefined],
  ['admin:{"token":3}', undefined],
  ['other:{"token":"fixture-token"}', undefined],
  ["admin:{", undefined],
  ["admin:null", undefined],
  ["admin:[]", undefined],
  ["admin:42", undefined],
  ["admin:", undefined],
  ['admin:\uFEFF{"token":"fixture-token"}', undefined],
] as const)(
  "decodes only prefixed JSON objects with nonblank token strings: %j",
  (raw, expected) => {
    expect(decodeProviderUsageAdminToken("admin:", raw)).toBe(expected);
  },
);
