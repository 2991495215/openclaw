import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { isSystemAgentOnlyCodexDynamicToolAllowlist } from "./dynamic-tool-profile.js";
import type {
  CodexDynamicToolCallOutputContentItem,
  CodexDynamicToolCallResponse,
} from "./protocol.js";

export function toTranscriptToolResult(
  response: CodexDynamicToolCallResponse,
): Record<string, unknown> {
  const { contentItems, success: _success, ...details } = response;
  return {
    ...details,
    content: contentItems.map(toTranscriptToolResultContentItem),
  };
}

function toTranscriptToolResultContentItem(
  item: CodexDynamicToolCallOutputContentItem,
): Record<string, unknown> {
  if (item.type === "inputText") {
    return { type: "text", text: typeof item.text === "string" ? item.text : "" };
  }
  if (item.type === "inputImage" && typeof item.imageUrl === "string") {
    return { type: "image", url: item.imageUrl };
  }
  const rawType = typeof item.type === "string" ? item.type.replace(/\s+/g, " ").trim() : "";
  const label = rawType ? truncateUtf16Safe(rawType, 80) : "unknown";
  const suffix = rawType.length > 80 ? "..." : "";
  return { type: "text", text: `[Unsupported Codex dynamic tool output: ${label}${suffix}]` };
}

export function resolveCodexDynamicToolDirectNames(
  params: EmbeddedRunAttemptParams,
  registeredTools: readonly { name: string }[],
  hostSystemAgentActive = false,
): string[] {
  // Tools with catalogMode=direct-only use the model-only namespace. This list
  // remains for control tools that intentionally live at the dynamic-tool root.
  return [
    // OpenClaw is the run's only tool and must stay callable when Codex tool
    // search is unavailable. Exact toolsAllow is the public harness contract.
    ...(hostSystemAgentActive && isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow)
      ? ["openclaw"]
      : []),
    // Registration owns persistent layout; a turn may narrow execution without
    // moving this tool into a namespace and changing the thread fingerprint.
    ...(registeredTools.some((tool) => tool.name === "message") ? ["message"] : []),
  ];
}
