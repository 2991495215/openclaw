/**
 * Runtime channel capability collector.
 *
 * Agent startup uses this to merge configured channel capabilities with prompt
 * tools and thread-bound spawn features that depend on channel policy.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntriesLower } from "@openclaw/normalization-core/string-normalization";
import { supportsThreadBindingSpawn } from "../channels/conversation-resolution.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import { resolveThreadBindingSpawnPolicy } from "../channels/thread-bindings-policy.js";
import { resolveChannelCapabilities } from "../config/channel-capabilities.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../utils/message-channel-normalize.js";
import {
  resolveChannelMessageToolHints,
  resolveChannelPromptCapabilities,
  resolveChannelReactionGuidance,
} from "./channel-tools.js";
import {
  resolveSpawnRequesterConversationTarget,
  type SpawnRequesterConversationSource,
} from "./spawn-requester-origin.js";

const THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY = "threadbound-subagent-spawn";
const THREAD_BOUND_ACP_SPAWN_CAPABILITY = "threadbound-acp-spawn";

/** Shared channel facts for ordinary and compaction system prompts. */
export function resolveRuntimeChannelPromptContext(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  requester?: SpawnRequesterConversationSource;
}) {
  const runtimeChannel = normalizeMessageChannel(params.channel);
  const context = { cfg: params.cfg, channel: runtimeChannel, accountId: params.accountId };
  let runtimeCapabilities: string[] | undefined;
  if (runtimeChannel) {
    // Control UI renders disclosures natively in its markdown pipeline.
    // This capability is core-owned because webchat has no channel plugin.
    const internalChannelCapabilities =
      runtimeChannel === INTERNAL_MESSAGE_CHANNEL ? ["markdownDetails"] : [];
    const threadSpawnCapabilities: string[] = [];
    const conversation = resolveSpawnRequesterConversationTarget(params.requester ?? {});
    if (
      params.cfg &&
      (conversation.to || conversation.threadId != null) &&
      supportsThreadBindingSpawn(runtimeChannel)
    ) {
      for (const [kind, capability] of [
        ["subagent", THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY],
        ["acp", THREAD_BOUND_ACP_SPAWN_CAPABILITY],
      ] as const) {
        const policy = resolveThreadBindingSpawnPolicy({
          cfg: params.cfg,
          channel: runtimeChannel,
          accountId: params.accountId ?? undefined,
          kind,
        });
        if (policy.enabled && policy.spawnEnabled) {
          threadSpawnCapabilities.push(capability);
        }
      }
    }
    const channelPromptCapabilities = params.cfg ? resolveChannelPromptCapabilities(context) : [];
    const merged = [...(resolveChannelCapabilities(context) ?? [])];
    const seen = new Set(normalizeStringEntriesLower(merged));
    for (const capability of [
      ...channelPromptCapabilities,
      ...internalChannelCapabilities,
      ...threadSpawnCapabilities,
    ]) {
      const normalizedCapability = normalizeOptionalLowercaseString(capability);
      if (!normalizedCapability || seen.has(normalizedCapability)) {
        continue;
      }
      seen.add(normalizedCapability);
      merged.push(capability);
    }
    runtimeCapabilities = merged.length > 0 ? merged : undefined;
  }
  return {
    runtimeChannel,
    ...(runtimeChannel && getChannelPlugin(runtimeChannel)?.agentPrompt?.customInlineButtonHint
      ? { customInlineButtonHint: true }
      : {}),
    runtimeCapabilities,
    reactionGuidance:
      runtimeChannel && params.cfg ? resolveChannelReactionGuidance(context) : undefined,
    messageToolHints: runtimeChannel ? resolveChannelMessageToolHints(context) : undefined,
  };
}
