import { describe, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import {
  createDynamicToolCall,
  createSingleToolBridge,
  createTool,
  specNames,
  textToolResult,
} from "./dynamic-tools.test-support.js";

describe("createCodexDynamicToolBridge catalog", () => {
  it.each(["local", "native"] as const)(
    "can retain a durable %s tool schema while denying execution for the current turn",
    async (catalog) => {
      const unavailableExecute = vi.fn(async () => textToolResult("automation recorded"));
      const onToolOutcome = vi.fn();
      const registeredTools = [
        createTool("message"),
        createTool("automations", { execute: unavailableExecute }),
      ];
      const bridge = createSingleToolBridge(createTool("message"), {
        registeredTools,
        ...(catalog === "native"
          ? {
              registeredSpecs: registeredTools.map((tool) => ({
                type: "function" as const,
                name: tool.name,
                description: tool.description,
                inputSchema: { type: "object", properties: {} },
              })),
            }
          : {}),
        hookContext: { runId: "run-unavailable", onToolOutcome },
      });

      expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
      expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["message"]);
      expect(specNames(bridge.specs).toSorted()).toEqual(["automations", "message"]);

      const result = await bridge.handleToolCall(createDynamicToolCall("automations"));

      expect(toCodexDynamicToolProtocolResponse(result)).toEqual({
        success: false,
        contentItems: [
          { type: "inputText", text: "OpenClaw tool is not available for this turn: automations" },
        ],
      });
      expect(result).toEqual(
        expect.objectContaining({ executionStarted: false, executedArguments: {} }),
      );
      expect(unavailableExecute).not.toHaveBeenCalled();
      expect(onToolOutcome).toHaveBeenLastCalledWith({
        toolName: "automations",
        argsHash: "",
        resultHash: "",
        terminalPresentation: undefined,
        presentationOnly: true,
      });
    },
  );
});
