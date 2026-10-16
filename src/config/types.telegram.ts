import type { z } from "zod";
import type { TelegramConfigSchema } from "../../extensions/telegram/config-api.js";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type {
  ChannelPreviewStreamingConfig,
  DmPolicy,
  SessionThreadBindingsConfig,
} from "./types.base.js";
import type {
  ChannelExecApprovalConfig,
  ChannelReactionConfig,
  CommonChannelGroupConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";

type SchemaTelegramAccount = SchemaContract<
  NonNullable<NonNullable<z.input<typeof TelegramConfigSchema>["accounts"]>[string]>
>;
type SchemaTelegramGroup = NonNullable<NonNullable<SchemaTelegramAccount["groups"]>[string]>;

export type TelegramActionConfig = NonNullable<SchemaTelegramAccount["actions"]>;

export type TelegramThreadBindingsConfig = SessionThreadBindingsConfig;

export type TelegramNetworkConfig = NonNullable<SchemaTelegramAccount["network"]>;

export type TelegramInlineButtonsScope = NonNullable<
  Exclude<TelegramCapabilitiesConfig, string[]>["inlineButtons"]
>;

export type TelegramPreviewStreamingConfig = ChannelPreviewStreamingConfig;

export type TelegramExecApprovalConfig = ChannelExecApprovalConfig;

export type TelegramCapabilitiesConfig = NonNullable<SchemaTelegramAccount["capabilities"]>;

export type TelegramCustomCommand = NonNullable<SchemaTelegramAccount["customCommands"]>[number];

type TelegramCommonConfig = CommonChannelMessagingConfig<
  TelegramCapabilitiesConfig,
  string | number,
  string | number,
  TelegramPreviewStreamingConfig
>;

export type TelegramAccountConfig = Omit<
  SchemaTelegramAccount,
  keyof TelegramCommonConfig | "groups" | "direct" | "webhookSecret" | "execApprovals"
> &
  TelegramCommonConfig &
  ChannelReactionConfig<"off" | "own" | "all", "off" | "ack" | "minimal" | "extensive", string> & {
    groups?: Record<string, TelegramGroupConfig>;
    direct?: Record<string, TelegramDirectConfig>;
    webhookSecret?: string;
    execApprovals?: TelegramExecApprovalConfig;
    /** @deprecated Legacy input only; Doctor migrates this to legacyWebhook.host. */
    webhookHost?: string;
    /** @deprecated Legacy input only; Doctor migrates this to legacyWebhook.port. */
    webhookPort?: number;
  };

export type TelegramTopicConfig = NonNullable<NonNullable<SchemaTelegramGroup["topics"]>[string]>;

export type TelegramGroupConfig = Omit<TelegramTopicConfig, "agentId"> &
  Pick<CommonChannelGroupConfig, "tools" | "toolsBySender"> & {
    /** Per-topic configuration (key is message_thread_id as string, or "*" for topic defaults). */
    topics?: Record<string, TelegramTopicConfig>;
  };

/** Config for LLM-based auto-topic labeling. */
export type AutoTopicLabelConfig = NonNullable<SchemaTelegramAccount["autoTopicLabel"]>;

export type TelegramDirectConfig = Omit<CommonChannelGroupConfig, "requireMention"> & {
  /** Per-DM override for DM message policy (open|disabled|allowlist). */
  dmPolicy?: DmPolicy;
  /** Per-topic configuration for DM topics (key is message_thread_id as string, or "*" for topic defaults). */
  topics?: Record<string, Omit<TelegramTopicConfig, "requireMentionInBotThreads">>;
  /** If true, require messages to be from a topic when topics are enabled. */
  requireTopic?: boolean;
  /** Controls outbound error reporting for this DM. */
  errorPolicy?: "always" | "once" | "silent";
  /** Auto-rename DM forum topics on first message using LLM. Default: true. */
  autoTopicLabel?: AutoTopicLabelConfig;
};

export type TelegramConfig = {
  accounts?: Record<string, TelegramAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & TelegramAccountConfig;
