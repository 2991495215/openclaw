import { Value } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import { SessionsListParamsSchema } from "./schema/sessions-list.js";
import { SessionRowSchema } from "./schema/sessions-row.js";
import { SessionsDescribeParamsSchema } from "./schema/sessions.js";
import {
  SESSION_ROW_FIELDS,
  SESSION_ROW_PRESETS,
  resolveSessionRowProjection,
  type ProjectedSessionRow,
} from "./session-row-fields.js";

const row = {
  key: "agent:main:dashboard:synthetic",
  kind: "direct",
  updatedAt: 100,
  sessionId: "session-1",
  lifecycleRevision: "revision-1",
  label: "Synthetic dashboard",
  hasBoard: true,
  unread: true,
  activeRunIds: ["run-1"],
  model: "example-model",
  contextWindows: [{ id: "default", label: "Default", contextWindow: 1000 }],
  toolOverrides: { webSearch: true },
};

describe("session row field projections", () => {
  it("derives selectable fields from the row schema", () => {
    expect(SESSION_ROW_FIELDS).toEqual(Object.keys(SessionRowSchema.properties));
  });

  it.each([SessionsListParamsSchema, SessionsDescribeParamsSchema])(
    "accepts closed, nonempty, unique field selections",
    (schema) => {
      const base = { key: row.key };
      const params = schema === SessionsListParamsSchema ? {} : base;
      expect(Value.Check(schema, { ...params, fields: ["label"], rowMode: "sidebar" })).toBe(true);
      for (const fields of [[], ["label", "label"], ["missingField"], [42]]) {
        expect(Value.Check(schema, { ...params, fields })).toBe(false);
      }
    },
  );

  it("always covers identity and unions presets in canonical order", () => {
    expect(resolveSessionRowProjection({ fields: ["label"] })?.fields).toEqual([
      "key",
      "rowMode",
      "rowProjectionId",
      "sessionId",
      "lifecycleRevision",
      "kind",
      "label",
      "updatedAt",
    ]);
    const first = resolveSessionRowProjection({
      rowMode: "dashboard",
      fields: ["unread", "model"],
    });
    const second = resolveSessionRowProjection({
      rowMode: "dashboard",
      fields: ["model", "unread"],
    });
    expect(first).toEqual(second);
    expect(first?.fields).toContain("hasBoard");
    expect(first?.fields).toContain("unread");
    expect(first?.fields).toContain("model");
    expect(first?.fields).not.toContain("contextWindows");
    expect(resolveSessionRowProjection({ rowMode: "sidebar" })).toBeUndefined();
  });

  it.each(["compact", "dashboard", "sidebar"] as const)(
    "preserves the %s preset's serialized row contract",
    (mode) => {
      const fields = new Set<string>(SESSION_ROW_PRESETS[mode]);
      const projected = Object.fromEntries(
        Object.entries(row).filter(([field]) => fields.has(field)),
      );
      const expected = {
        compact: {
          key: row.key,
          kind: "direct",
          updatedAt: 100,
          sessionId: "session-1",
          lifecycleRevision: "revision-1",
          label: "Synthetic dashboard",
          hasBoard: true,
          unread: true,
          activeRunIds: ["run-1"],
          model: "example-model",
        },
        dashboard: {
          key: row.key,
          kind: "direct",
          updatedAt: 100,
          sessionId: "session-1",
          lifecycleRevision: "revision-1",
          label: "Synthetic dashboard",
          hasBoard: true,
        },
        sidebar: {
          key: row.key,
          kind: "direct",
          updatedAt: 100,
          sessionId: "session-1",
          lifecycleRevision: "revision-1",
          label: "Synthetic dashboard",
          hasBoard: true,
          unread: true,
          activeRunIds: ["run-1"],
        },
      };
      expect(JSON.stringify(projected)).toBe(JSON.stringify(expected[mode]));
    },
  );

  it("limits a renderer row type to its declared fields and identity", () => {
    const fields = ["label", "unread"] as const;
    expectTypeOf<keyof ProjectedSessionRow<typeof fields>>().toEqualTypeOf<
      | "key"
      | "kind"
      | "updatedAt"
      | "sessionId"
      | "lifecycleRevision"
      | "rowMode"
      | "rowProjectionId"
      | "label"
      | "unread"
    >();
  });
});
