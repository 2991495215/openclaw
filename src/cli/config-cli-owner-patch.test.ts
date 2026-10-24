import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { buildConfigOwnerPatch } from "./config-cli-owner-patch.js";

describe("buildConfigOwnerPatch", () => {
  it("sends only the change, with array replacement and deletion as explicit intent", () => {
    const previous: OpenClawConfig = {
      gateway: { reload: { mode: "hybrid" }, nodes: { commands: { allow: ["a", "b"] } } },
      agents: { entries: { main: { skills: ["notes"] } } },
    };
    const next: OpenClawConfig = {
      gateway: { reload: { mode: "off" }, nodes: { commands: { allow: ["b"] } } },
      agents: { entries: {} },
    };
    const request = buildConfigOwnerPatch({ previous, next });
    expect(JSON.parse(request.raw)).toEqual({
      gateway: { reload: { mode: "off" }, nodes: { commands: { allow: ["b"] } } },
      agents: { entries: { main: null } },
    });
    expect(request.replacePaths).toEqual([
      "gateway.nodes.commands.allow",
      "agents.entries.main.skills",
    ]);
  });

  it("refuses a change the Gateway's merge patch cannot reproduce", () => {
    expect(() =>
      buildConfigOwnerPatch({
        previous: {},
        // An authored null is not a value a merge patch can carry; null means delete.
        next: JSON.parse('{"gateway":{"remote":{"url":null}}}'),
      }),
    ).toThrow("cannot be expressed as a Gateway config patch");
  });
});
