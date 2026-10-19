/** Dependency-light ownership metadata for channel-contributed agent tools. */
import type { ChannelAgentTool } from "../channels/plugins/types.public.js";

type ChannelAgentToolMeta = {
  channelId: string;
};

const channelAgentToolMeta = new WeakMap<ChannelAgentTool, ChannelAgentToolMeta>();

export function getChannelAgentToolMeta(tool: ChannelAgentTool): ChannelAgentToolMeta | undefined {
  return channelAgentToolMeta.get(tool);
}

export function setChannelAgentToolMeta(tool: ChannelAgentTool, meta: ChannelAgentToolMeta): void {
  channelAgentToolMeta.set(tool, meta);
}

/** Copy channel metadata when wrapping or replacing a channel-owned tool. */
export function copyChannelAgentToolMeta(source: ChannelAgentTool, target: ChannelAgentTool): void {
  const meta = channelAgentToolMeta.get(source);
  if (meta) {
    channelAgentToolMeta.set(target, meta);
  }
}
