import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  normalizeBindingConfig,
  normalizeMode,
  normalizeText,
  parseConfiguredAcpSessionKey,
  toConfiguredAcpBindingRecord,
} from "../../acp/persistent-bindings.types.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { parseModelRef } from "../../agents/model-selection-normalize.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import { listConfiguredBindings } from "../../config/bindings.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import { getPluginRegistryForContext } from "../../plugins/runtime/gateway-request-scope.js";
import { pickFirstExistingAgentId } from "../../routing/resolve-route.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import type {
  CompiledConfiguredBinding,
  ConfiguredBindingRecordResolution,
  ConfiguredBindingResolution,
} from "./binding-types.js";
import { getLoadedChannelPluginEntryById } from "./registry-loaded.js";
import type { ChannelConfiguredBindingMatch } from "./types.adapters.js";
import type { ChannelId } from "./types.public.js";

function resolveCompiledBindingRegistry(cfg: OpenClawConfig) {
  const rulesByChannel = new Map<ChannelId, CompiledConfiguredBinding[]>();

  for (const binding of listConfiguredBindings(cfg)) {
    // Ordinary routing bindings share the config array but have no stateful target.
    // Reject them before consulting the loaded channel registry on request-time route lookups.
    if (binding.type !== "acp") {
      continue;
    }
    const bindingConversationId = normalizeOptionalString(binding.match?.peer?.id);
    if (!bindingConversationId) {
      continue;
    }

    const channel = normalizeOptionalLowercaseString(binding.match.channel);
    if (!channel) {
      continue;
    }
    // Candidate validation and admitted routing compile against their exact owner.
    const plugin = getLoadedChannelPluginEntryById(
      channel,
      getPluginRegistryForContext() ?? undefined,
    )?.plugin;
    const provider = plugin?.bindings;
    if (!plugin || !provider?.compileConfiguredBinding || !provider.matchInboundConversation) {
      continue;
    }
    const channelId = plugin.id;
    const target = provider.compileConfiguredBinding({
      binding,
      conversationId: bindingConversationId,
    });
    if (!target) {
      continue;
    }

    const agentId = pickFirstExistingAgentId(cfg, binding.agentId ?? "main");
    // Binding config overrides ACP runtime defaults; unset fields remain harness-owned.
    const agent = resolveAgentConfig(cfg, agentId);
    const runtimeDefaults = agent?.runtime?.type === "acp" ? agent.runtime.acp : undefined;
    const acpAgentId = normalizeText(runtimeDefaults?.agent);
    const bindingOverrides = normalizeBindingConfig(binding.acp);
    const mode = normalizeMode(bindingOverrides.mode ?? normalizeText(runtimeDefaults?.mode));
    // Every ACP binding uses its owner's explicit model, regardless of the owner's runtime type.
    const model = resolvePrimaryStringValue(agent?.model);
    const modelRef = model ? parseModelRef(model, "") : null;
    const thinking =
      agent?.thinkingDefault ??
      (modelRef
        ? resolveConfiguredThinkingDefault({ cfg, ...modelRef })
        : cfg.agents?.defaults?.thinkingDefault);
    // Unconfigured workspaces stay unset so ACP can choose its normal default.
    const cwd =
      bindingOverrides.cwd ??
      normalizeText(runtimeDefaults?.cwd) ??
      (normalizeText(agent?.workspace) || normalizeText(cfg.agents?.defaults?.workspace)
        ? resolveAgentWorkspaceDir(cfg, agentId)
        : undefined);
    const backend = bindingOverrides.backend ?? normalizeText(runtimeDefaults?.backend);
    const rule: CompiledConfiguredBinding = {
      channel: channelId,
      accountPattern: normalizeOptionalString(binding.match.accountId),
      binding,
      bindingConversationId,
      target,
      agentId,
      provider,
      targetFactory: {
        driverId: "acp",
        materialize: ({ accountId, conversation }) => {
          // Wildcard bindings get a stable session key only after the conversation is known.
          const record = toConfiguredAcpBindingRecord({
            channel: channelId,
            accountId,
            conversationId: conversation.conversationId,
            parentConversationId: conversation.parentConversationId,
            agentId,
            acpAgentId,
            mode,
            model,
            thinking,
            cwd,
            backend,
            label: bindingOverrides.label,
          });
          return {
            record,
            statefulTarget: {
              kind: "stateful",
              driverId: "acp",
              sessionKey: record.targetSessionKey,
              agentId,
              ...(bindingOverrides.label ? { label: bindingOverrides.label } : {}),
            },
          };
        },
      },
    };
    const rules = rulesByChannel.get(rule.channel) ?? [];
    rules.push(rule);
    rulesByChannel.set(rule.channel, rules);
  }

  return rulesByChannel;
}

function resolveAccountMatchPriority(match: string | undefined, actual: string): 0 | 1 | 2 {
  if (!match) {
    return actual === DEFAULT_ACCOUNT_ID ? 2 : 0;
  }
  if (match === "*") {
    return 1;
  }
  return normalizeAccountId(match) === actual ? 2 : 0;
}

/** Compile plugin binding rules before publishing a config or plugin generation. */
export function validateConfiguredBindings(cfg: OpenClawConfig): void {
  resolveCompiledBindingRegistry(cfg);
}

/**
 * Resolves a configured binding record from explicit channel/account/conversation ids.
 */
export function resolveConfiguredBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ConfiguredBindingRecordResolution | null {
  const resolved = resolveConfiguredBinding({
    cfg: params.cfg,
    conversation: params,
  });
  return resolved ? { record: resolved.record, statefulTarget: resolved.statefulTarget } : null;
}

/**
 * Resolves the full configured binding match, including compiled rule and match diagnostics.
 */
export function resolveConfiguredBinding(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): ConfiguredBindingResolution | null {
  const channel = normalizeOptionalLowercaseString(params.conversation.channel);
  const conversationId = params.conversation.conversationId.trim();
  if (!channel || !conversationId) {
    return null;
  }
  const conversation = {
    channel,
    accountId: normalizeAccountId(params.conversation.accountId),
    conversationId,
    parentConversationId: normalizeOptionalString(params.conversation.parentConversationId),
  };
  const rules = resolveCompiledBindingRegistry(params.cfg).get(channel);
  let bestMatch: { rule: CompiledConfiguredBinding; match: ChannelConfiguredBindingMatch } | null =
    null;
  let bestAccountPriority = 0;
  let bestMatchPriority = 0;
  for (const rule of rules ?? []) {
    const accountMatchPriority = resolveAccountMatchPriority(
      rule.accountPattern,
      conversation.accountId,
    );
    if (accountMatchPriority === 0) {
      continue;
    }
    const match = rule.provider.matchInboundConversation({
      binding: rule.binding,
      compiledBinding: rule.target,
      conversationId,
      parentConversationId: conversation.parentConversationId,
    });
    if (!match) {
      continue;
    }
    const matchPriority = match.matchPriority ?? 0;
    // Exact accounts outrank wildcards, then the channel's conversation priority decides.
    if (
      !bestMatch ||
      accountMatchPriority > bestAccountPriority ||
      (accountMatchPriority === bestAccountPriority && matchPriority > bestMatchPriority)
    ) {
      bestMatch = { rule, match };
      bestAccountPriority = accountMatchPriority;
      bestMatchPriority = matchPriority;
    }
  }
  if (!bestMatch) {
    return null;
  }
  return {
    conversation,
    compiledBinding: bestMatch.rule,
    match: bestMatch.match,
    ...bestMatch.rule.targetFactory.materialize({
      accountId: conversation.accountId,
      conversation: bestMatch.match,
    }),
  };
}

/**
 * Resolves a configured binding record by the stateful target session key.
 */
export function resolveConfiguredBindingRecordBySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): ConfiguredBindingRecordResolution | null {
  const registry = resolveCompiledBindingRegistry(params.cfg);
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const parsed = parseConfiguredAcpSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const rules = registry.get(parsed.channel);
  if (!rules) {
    return null;
  }
  let wildcardMatch: ConfiguredBindingRecordResolution | null = null;
  for (const rule of rules) {
    const accountMatchPriority = resolveAccountMatchPriority(rule.accountPattern, parsed.accountId);
    if (accountMatchPriority === 0) {
      continue;
    }
    // Wildcard rules derive their target session key from the parsed account.
    const materializedTarget = rule.targetFactory.materialize({
      accountId: parsed.accountId,
      conversation: rule.target,
    });
    if (materializedTarget.record.targetSessionKey === sessionKey) {
      if (accountMatchPriority === 2) {
        // Exact account matches outrank wildcard account bindings for the same session key.
        return materializedTarget;
      }
      wildcardMatch = materializedTarget;
    }
  }
  return wildcardMatch;
}
