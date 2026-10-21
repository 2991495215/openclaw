import { describe, expect, it } from "vitest";
import {
  bindAgentToolAvailability,
  finalizeAgentToolAvailability,
  gateAgentToolExecution,
} from "./agent-tool-availability.js";
import { resolveTurnToolSurface } from "./agent-tools.turn-authority.js";
import type { AnyAgentTool } from "./tools/common.js";

function tool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: { ran: name } }),
  } as unknown as AnyAgentTool;
}

describe("resolveTurnToolSurface", () => {
  it("retains early-gated definitions without exporting their execution capability", async () => {
    const unavailable = gateAgentToolExecution(tool("client_tool"), "No current client");
    const surface = resolveTurnToolSurface({
      turnTools: [unavailable],
      ownerOnlyDenied: new Set(),
    });
    expect(surface.tools.map((entry) => entry.name)).toEqual(["client_tool"]);
    expect(surface.callableTools).toEqual([]);
    expect(surface.exportedTools).toEqual([]);
    expect(surface.turnAuthorized(unavailable)).toBe(false);
    expect((await surface.tools[0]!.execute("denied", {})).details).toEqual({ gated: true });
  });
  it("keeps a gated dependency non-callable for dependent affordances", () => {
    // A spawn tool may enable result collection only while its reader is callable.
    let readerCallable: boolean | undefined;
    const reader = bindAgentToolAvailability(tool("agents_wait"), { prepare: () => {} });
    const spawn = bindAgentToolAvailability(tool("sessions_spawn"), {
      prepare: (_tool, callable) => {
        readerCallable = callable.has("agents_wait");
      },
    });
    const { tools } = resolveTurnToolSurface({
      turnTools: [spawn],
      sessionTools: [spawn, reader],
      ownerOnlyDenied: new Set(),
    });

    expect(tools.map((entry) => entry.name)).toEqual(["sessions_spawn", "agents_wait"]);
    finalizeAgentToolAvailability(tools);
    expect(readerCallable).toBe(false);
  });
});
