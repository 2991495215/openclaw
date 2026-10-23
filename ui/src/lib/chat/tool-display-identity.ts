import type { ToolDisplaySpec } from "../../../../src/agents/tool-display-common.js";
import {
  defaultTitle,
  normalizeToolDisplayName,
} from "../../../../src/agents/tool-display-name.js";
import { resolveToolDisplayIcon } from "./tool-display-icon.ts";
import TOOL_PRESENTATION from "./tool-display-presentation.generated.json" with { type: "json" };

const TOOL_MAP: Record<string, Pick<ToolDisplaySpec, "title" | "label">> = TOOL_PRESENTATION.tools;

/** Labels and icons do not need the argument-detail parsers. */
export function resolveToolDisplayIdentity(toolName?: string) {
  const name = normalizeToolDisplayName(toolName);
  const spec = TOOL_MAP[name.toLowerCase()];
  return {
    name,
    label: spec?.label ?? spec?.title ?? defaultTitle(name),
    icon: resolveToolDisplayIcon(name),
  };
}
