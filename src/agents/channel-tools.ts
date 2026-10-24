/**
 * Channel-owned agent tool and prompt helpers.
 * Discovers channel tools, message actions, prompt hints, and weakly-attached
 * channel metadata for wrapped tools.
 */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import {
  type ChannelMessageActionDiscoveryInput,
  createMessageActionDiscoveryContext,
  type MessageActionDiscoverySteps,
  resolveMessageActionDiscoveryChannelId,
  resolveCurrentChannelMessageToolDiscoveryAdapter,
  type PreparedMessageToolCatalog,
} from "../channels/plugins/message-action-discovery.js";
import type {
  ChannelAgentTool,
  ChannelMessageActionName,
} from "../channels/plugins/types.public.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setChannelAgentToolMeta } from "./channel-tool-metadata.js";

export { getChannelAgentToolMeta } from "./channel-tool-metadata.js";

type ChannelMessageActionDiscoveryParams = Omit<
  ChannelMessageActionDiscoveryInput,
  "channel" | "currentChannelProvider"
> & {
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
};

/**
 * Get the list of supported message actions for a specific channel.
 * Returns an empty array if channel is not found or has no actions configured.
 */
export function* listChannelSupportedActionsSteps(
  params: ChannelMessageActionDiscoveryParams & { channel?: string },
): MessageActionDiscoverySteps<ChannelMessageActionName[]> {
  const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(
    channelId,
    params.preparedMessageToolCatalog,
  );
  if (!pluginActions?.actions) {
    return [];
  }
  const discovered = yield {
    pluginId: pluginActions.pluginId,
    actions: pluginActions.actions,
    context: createMessageActionDiscoveryContext(params),
    includeActions: true,
  };
  return discovered.actions;
}

export function listChannelAgentTools(params: { cfg?: OpenClawConfig }): ChannelAgentTool[] {
  const tools: ChannelAgentTool[] = [];
  for (const plugin of listChannelPlugins()) {
    const entry = plugin.agentTools;
    if (!entry) {
      continue;
    }
    const resolved = typeof entry === "function" ? entry(params) : entry;
    if (Array.isArray(resolved)) {
      for (const tool of resolved) {
        setChannelAgentToolMeta(tool, { channelId: plugin.id });
      }
      tools.push(...resolved);
    }
  }
  return tools;
}

/** Resolve channel-specific message tool hints for system prompt assembly. */
export function resolveChannelMessageToolHints(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): string[] {
  const channelId = normalizeAnyChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const resolve = getChannelPlugin(channelId)?.agentPrompt?.messageToolHints;
  if (!resolve) {
    return [];
  }
  const cfg = params.cfg ?? {};
  return normalizeStringEntries(resolve({ cfg, accountId: params.accountId }));
}
