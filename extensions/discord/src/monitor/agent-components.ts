import type { BaseMessageInteractiveComponent } from "../internal/discord.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
} from "./agent-components.system-controls.js";
import type { AgentComponentContext } from "./agent-components.types.js";

export { createDiscordComponentModal } from "./agent-components.handlers.js";
export { createDiscordComponentControls } from "./agent-components.wildcard-controls.js";

type ComponentFactory = (ctx: AgentComponentContext) => BaseMessageInteractiveComponent;

export const createAgentComponentControls = [
  createAgentComponentButton,
  createAgentSelectMenu,
] satisfies readonly ComponentFactory[];
