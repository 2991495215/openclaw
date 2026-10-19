import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPluginConfigSafeParse } from "./extension-shared.js";

describe("createPluginConfigSafeParse", () => {
  it("preserves schema-owned transforms and optional defaults", () => {
    const schema = z.strictObject({ name: z.string().trim() });
    const optional = createPluginConfigSafeParse(
      schema.transform((value) => ({ name: value.name.toUpperCase() })).optional(),
    );
    const defaults = createPluginConfigSafeParse(
      schema.optional().transform((value) => value ?? { name: "default" }),
    );
    expect(optional(undefined)).toEqual({ success: true, data: undefined });
    expect(defaults(undefined)).toEqual({ success: true, data: { name: "default" } });
    expect(optional({ name: " trimmed " })).toEqual({ success: true, data: { name: "TRIMMED" } });
  });

  it("uses stable plugin diagnostics for root types, unknown keys and nested issues", () => {
    const parse = createPluginConfigSafeParse(
      z.strictObject({ name: z.string({ error: "name must be text" }) }),
    );
    expect(parse(null)).toEqual({
      success: false,
      error: { issues: [{ path: [], message: "expected config object" }] },
    });
    expect(parse({ name: "valid", extra: true })).toEqual({
      success: false,
      error: { issues: [{ path: [], message: "unknown config key: extra" }] },
    });
    expect(parse({ name: 7 })).toEqual({
      success: false,
      error: { issues: [{ path: ["name"], message: "name must be text" }] },
    });
  });
});
