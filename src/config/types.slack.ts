import type { z } from "zod";
import type { SlackConfigSchema } from "../../extensions/slack/config-api.js";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type { ChannelStreamingConfig, ChannelStreamingProgressConfig } from "./types.base.js";
import type {
  ChannelBotInteractionConfig,
  ChannelExecApprovalConfig,
  ChannelReactionConfig,
  CommonChannelGroupConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";

type SchemaSlackAccount = SchemaContract<
  NonNullable<NonNullable<z.input<typeof SlackConfigSchema>["accounts"]>[string]>
>;
type SchemaSlackChannel = NonNullable<NonNullable<SchemaSlackAccount["channels"]>[string]>;

export type SlackDmConfig = NonNullable<SchemaSlackAccount["dm"]>;

export type SlackChannelConfig = Omit<SchemaSlackChannel, "tools" | "toolsBySender"> &
  Pick<CommonChannelGroupConfig, "tools" | "toolsBySender">;

export type SlackReactionNotificationMode = NonNullable<
  SchemaSlackAccount["reactionNotifications"]
>;

// DO NOT REMOVE OR CHANGE THE COMPACT STYLE WITHOUT APPROVAL FROM SJF OR PASHPASHPASH.
export type SlackStreamingProgressConfig = ChannelStreamingProgressConfig & {
  /** Slack progress presentation. "compact" keeps one editable text draft. Default: "card". */
  style?: "card" | "compact";
  /** Use Slack-native task cards for card-style progress. Default: true. */
  nativeTaskCards?: boolean;
};
export type SlackChannelStreamingConfig = ChannelStreamingConfig<SlackStreamingProgressConfig>;
export type SlackExecApprovalConfig = ChannelExecApprovalConfig;
export type SlackCapabilitiesConfig = string[];

export type SlackActionConfig = NonNullable<SchemaSlackAccount["actions"]>;

export type SlackSlashCommandConfig = NonNullable<SchemaSlackAccount["slashCommand"]>;

export type SlackThreadConfig = NonNullable<SchemaSlackAccount["thread"]>;

export type SlackRelayConfig = NonNullable<SchemaSlackAccount["relay"]>;

type SlackCommonConfig = Omit<
  CommonChannelMessagingConfig<
    SlackCapabilitiesConfig,
    string | number,
    string,
    SlackChannelStreamingConfig
  >,
  "groupAllowFrom"
>;

export type SlackAccountConfig = Omit<
  SchemaSlackAccount,
  keyof SlackCommonConfig | "channels" | "execApprovals"
> &
  SlackCommonConfig &
  ChannelBotInteractionConfig &
  ChannelReactionConfig<SlackReactionNotificationMode, never, string, true> & {
    /** @deprecated Doctor-only legacy input. */
    identity?: "bot" | "user";
    /** @deprecated Doctor-only legacy input. */
    socketMode?: {
      clientPingTimeout?: number;
      serverPingTimeout?: number;
      pingPongLoggingEnabled?: boolean;
    };
    channels?: Record<string, SlackChannelConfig>;
    execApprovals?: SlackExecApprovalConfig;
  };

export type SlackConfig = {
  accounts?: Record<string, SlackAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & SlackAccountConfig;
