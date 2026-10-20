import { describe, expect, it } from "vitest";
import { extractFailoverSignalDetails } from "./classify.js";

describe("extractFailoverSignalDetails", () => {
  it("expands serialized objects in field order while keeping plain detail strings", () => {
    const serialized = '{"message":"outer","error":{"code":"nested"}}';
    expect(extractFailoverSignalDetails(serialized, " { ", "[]", "42")).toEqual([
      serialized,
      "outer",
      "nested",
      "{",
      "[]",
      "42",
    ]);
  });

  it("bounds candidates and avoids revisiting cyclic objects", () => {
    const cyclic: Record<string, unknown> = { message: "first" };
    cyclic.error = cyclic;
    expect(extractFailoverSignalDetails(cyclic, "last")).toEqual(["first", "last"]);
    expect(
      extractFailoverSignalDetails(...Array.from({ length: 20 }, (_, index) => index)),
    ).toEqual(Array.from({ length: 12 }, (_, index) => String(index)));
  });

  it.each([
    {
      name: "backs off before a split surrogate pair",
      input: `${"a".repeat(999)}🎉!`,
      expected: "a".repeat(999),
    },
    {
      name: "keeps the full ASCII budget",
      input: "a".repeat(1001),
      expected: "a".repeat(1000),
    },
  ])("$name in nested provider details", ({ input, expected }) => {
    const details = extractFailoverSignalDetails({ error: { body: { detail: input } } });

    expect(details).toEqual([expected]);
  });
});
