import { iconData, type IconName } from "../../components/icon-data.ts";
import TOOL_PRESENTATION from "./tool-display-presentation.generated.json" with { type: "json" };

const tools = new Map<string, { icon: string }>(Object.entries(TOOL_PRESENTATION.tools));

// Foreign tool previews and generic rows can lack the arguments needed for row-kind icons.
const TOOL_NAME_ALIASES = new Map([
  ["shell", "exec"],
  ["search", "web_search"],
  ["grep", "web_search"],
  ["find", "web_search"],
  ["glob", "web_search"],
]);

function isIconName(name: string): name is IconName {
  return Object.hasOwn(iconData, name);
}

export function resolveToolDisplayIcon(name: string): IconName {
  const key = name.trim().toLowerCase();
  const spec =
    tools.get(key) ?? tools.get(TOOL_NAME_ALIASES.get(key) ?? "") ?? TOOL_PRESENTATION.fallback;
  return isIconName(spec.icon) ? spec.icon : "puzzle";
}
