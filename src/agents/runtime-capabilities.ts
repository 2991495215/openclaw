/**
 * Runtime channel capability collector.
 *
 * Agent startup uses this to merge configured channel capabilities with prompt
 * tools and thread-bound spawn features that depend on channel policy.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "@openclaw/normalization-core/string-normalization";
import { supportsThreadBindingSpawn } from "../channels/conversation-resolution.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import {
  channelPluginHasNativeApprovalPromptUi,
  NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY,
} from "../channels/plugins/native-approval-prompt.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import { resolveThreadBindingSpawnPolicy } from "../channels/thread-bindings-policy.js";
import { resolveChannelCapabilities } from "../config/channel-capabilities.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../utils/message-channel-normalize.js";
import { resolveChannelMessageToolHints } from "./channel-tools.js";
import {
  resolveSpawnRequesterConversationTarget,
  type SpawnRequesterConversationSource,
} from "./spawn-requester-origin.js";

const THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY = "threadbound-subagent-spawn";
const THREAD_BOUND_ACP_SPAWN_CAPABILITY = "threadbound-acp-spawn";

function mergeRuntimeCapabilities(
  base?: readonly string[] | null,
  additions: readonly string[] = [],
): string[] | undefined {
  const merged = [...(base ?? [])];
  const seen = new Set(normalizeStringEntriesLower(merged));

  for (const capability of additions) {
    const normalizedCapability = normalizeOptionalLowercaseString(capability);
    if (!normalizedCapability || seen.has(normalizedCapability)) {
      continue;
    }
    seen.add(normalizedCapability);
    merged.push(capability);
  }

  return merged.length > 0 ? merged : undefined;
}

/** Collects the effective runtime capabilities for a channel/account pair. */
export function collectRuntimeChannelCapabilities(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  requester?: SpawnRequesterConversationSource;
}): string[] | undefined {
  if (!params.channel) {
    return undefined;
  }
  // Control UI renders disclosures natively in its markdown pipeline.
  // This capability is core-owned because webchat has no channel plugin.
  const internalChannelCapabilities =
    params.channel === INTERNAL_MESSAGE_CHANNEL ? ["markdownDetails"] : [];
  const threadSpawnCapabilities: string[] = [];
  const { requester, ...channelContext } = params;
  const conversation = resolveSpawnRequesterConversationTarget(requester ?? {});
  if (
    params.cfg &&
    (conversation.to || conversation.threadId != null) &&
    supportsThreadBindingSpawn(params.channel)
  ) {
    for (const [kind, capability] of [
      ["subagent", THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY],
      ["acp", THREAD_BOUND_ACP_SPAWN_CAPABILITY],
    ] as const) {
      const policy = resolveThreadBindingSpawnPolicy({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId ?? undefined,
        kind,
      });
      if (policy.enabled && policy.spawnEnabled) {
        threadSpawnCapabilities.push(capability);
      }
    }
  }
  const channelId = params.cfg ? normalizeAnyChannelId(params.channel) : null;
  const plugin = channelId ? getChannelPlugin(channelId) : undefined;
  const channelPromptCapabilities = params.cfg
    ? normalizeStringEntries(
        plugin?.agentPrompt?.messageToolCapabilities?.({
          cfg: params.cfg,
          accountId: params.accountId,
        }) ?? [],
      )
    : [];
  if (params.cfg && channelPluginHasNativeApprovalPromptUi(plugin)) {
    channelPromptCapabilities.push(NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY);
  }
  return mergeRuntimeCapabilities(resolveChannelCapabilities(channelContext), [
    ...channelPromptCapabilities,
    ...internalChannelCapabilities,
    ...threadSpawnCapabilities,
  ]);
}

/** Shared channel facts for ordinary and compaction system prompts. */
export function resolveRuntimeChannelPromptContext(
  params: Parameters<typeof collectRuntimeChannelCapabilities>[0],
) {
  const runtimeChannel = normalizeMessageChannel(params.channel);
  const context = { cfg: params.cfg, channel: runtimeChannel, accountId: params.accountId };
  const runtimeCapabilities = collectRuntimeChannelCapabilities({
    ...context,
    requester: params.requester,
  });
  const customInlineButtonHint =
    runtimeChannel && getChannelPlugin(runtimeChannel)?.agentPrompt?.customInlineButtonHint;
  const channelId = params.cfg ? normalizeAnyChannelId(runtimeChannel) : null;
  const reactionGuidance =
    channelId && params.cfg
      ? getChannelPlugin(channelId)?.agentPrompt?.reactionGuidance?.({
          cfg: params.cfg,
          accountId: params.accountId,
        })
      : undefined;
  return {
    runtimeChannel,
    ...(customInlineButtonHint ? { customInlineButtonHint: true } : {}),
    runtimeCapabilities,
    reactionGuidance:
      channelId && reactionGuidance?.level
        ? {
            level: reactionGuidance.level,
            channel: reactionGuidance.channelLabel?.trim() || channelId,
          }
        : undefined,
    messageToolHints: runtimeChannel ? resolveChannelMessageToolHints(context) : undefined,
  };
}
