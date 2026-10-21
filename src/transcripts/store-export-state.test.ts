import { expect, it } from "vitest";
import { parseTranscriptPendingExports } from "./store-export-state.js";

it.each([
  { json: "[]", expected: [] },
  { json: '["metadata.json",""," ","metadata.json"]', expected: ["metadata.json", "", " "] },
])("reads pending export names without coercion from $json", ({ json, expected }) => {
  expect([...parseTranscriptPendingExports(json)]).toEqual(expected);
});

it.each(["null", "{}", '"metadata.json"', '["metadata.json",1]', "[null]"])(
  "rejects malformed pending export data %s",
  (json) => {
    expect(() => parseTranscriptPendingExports(json)).toThrow(
      new TypeError("Invalid pending transcript exports: expected an array of strings."),
    );
  },
);

it("rejects invalid pending export JSON", () => {
  expect(() => parseTranscriptPendingExports("[")).toThrow(SyntaxError);
});
