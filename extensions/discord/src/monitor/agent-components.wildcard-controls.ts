import { ComponentType } from "discord-api-types/v10";
import { parseDiscordComponentCustomIdForInteraction } from "../component-custom-id.js";
import type { DiscordComponentSelectType } from "../components.types.js";
import type {
  BaseMessageInteractiveComponent,
  BaseComponentInteraction,
  ComponentData,
} from "../internal/discord.js";
import { parseDiscordComponentData, resolveInteractionCustomId } from "./agent-components-data.js";
import {
  handleDiscordComponentEvent,
  handleDiscordModalTrigger,
} from "./agent-components.handlers.js";
import type {
  AgentComponentContext,
  AgentComponentMessageInteraction,
} from "./agent-components.types.js";

type SelectControlSpec = {
  type: ComponentType;
  kind: DiscordComponentSelectType;
};

const SELECT_CONTROLS = [
  { type: ComponentType.StringSelect, kind: "string" },
  { type: ComponentType.UserSelect, kind: "user" },
  { type: ComponentType.RoleSelect, kind: "role" },
  { type: ComponentType.MentionableSelect, kind: "mentionable" },
  { type: ComponentType.ChannelSelect, kind: "channel" },
] satisfies SelectControlSpec[];

function createDiscordComponentSelectControl(
  spec: SelectControlSpec,
  ctx: AgentComponentContext,
): BaseMessageInteractiveComponent {
  return {
    customIdParser: parseDiscordComponentCustomIdForInteraction,
    type: spec.type,
    customId: `__openclaw_discord_component_${spec.kind}_select_wildcard__`,

    async run(interaction: AgentComponentMessageInteraction, data: ComponentData): Promise<void> {
      await handleDiscordComponentEvent({
        ctx,
        interaction,
        data,
        componentLabel: spec.kind === "string" ? "select menu" : `${spec.kind} select`,
        label:
          spec.kind === "string"
            ? "discord component select"
            : `discord component ${spec.kind} select`,
        values: interaction.values ?? [],
      });
    },
  };
}

function createDiscordComponentButton(ctx: AgentComponentContext): BaseMessageInteractiveComponent {
  return {
    type: ComponentType.Button,
    customId: "__openclaw_discord_component_button_wildcard__",
    customIdParser: parseDiscordComponentCustomIdForInteraction,

    async run(interaction: BaseComponentInteraction, data: ComponentData): Promise<void> {
      const parsed = parseDiscordComponentData(data, resolveInteractionCustomId(interaction));
      if (parsed?.modalId) {
        await handleDiscordModalTrigger({
          ctx,
          interaction,
          data,
          label: "discord component modal",
        });
        return;
      }
      await handleDiscordComponentEvent({
        ctx,
        interaction,
        data,
        componentLabel: "button",
        label: "discord component button",
      });
    },
  };
}

export const createDiscordComponentControls = [
  createDiscordComponentButton,
  ...SELECT_CONTROLS.map(
    (spec) => (ctx: AgentComponentContext) => createDiscordComponentSelectControl(spec, ctx),
  ),
];
