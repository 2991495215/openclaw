import type { z } from "zod";
import type { DiscordConfigSchema } from "../../extensions/discord/config-api.js";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type { ChannelPreviewStreamingConfig, SessionThreadBindingsConfig } from "./types.base.js";
import type {
  ChannelBotInteractionConfig,
  ChannelExecApprovalConfig,
  ChannelReactionConfig,
  CommonChannelGroupConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { TtsConfig } from "./types.tts.js";

type SchemaDiscordAccount = SchemaContract<
  NonNullable<NonNullable<z.output<typeof DiscordConfigSchema>["accounts"]>[string]>
>;
type SchemaDiscordGuild = NonNullable<NonNullable<SchemaDiscordAccount["guilds"]>[string]>;
type SchemaDiscordGuildChannel = NonNullable<NonNullable<SchemaDiscordGuild["channels"]>[string]>;

export type DiscordChannelStreamingConfig = ChannelPreviewStreamingConfig;

export type DiscordPluralKitConfig = Omit<
  NonNullable<SchemaDiscordAccount["pluralkit"]>,
  "token"
> & { token?: string };

export type DiscordMentionAliasesConfig = Record<string, string>;

export type DiscordDmConfig = NonNullable<SchemaDiscordAccount["dm"]>;

export type DiscordGuildChannelConfig = Omit<SchemaDiscordGuildChannel, "tools" | "toolsBySender"> &
  Pick<CommonChannelGroupConfig, "tools" | "toolsBySender">;

export type DiscordReactionNotificationMode = NonNullable<
  SchemaDiscordGuild["reactionNotifications"]
>;

export type DiscordGuildEntry = Omit<SchemaDiscordGuild, "channels" | "tools" | "toolsBySender"> &
  Pick<CommonChannelGroupConfig, "tools" | "toolsBySender"> & {
    channels?: Record<string, DiscordGuildChannelConfig>;
  };

export type DiscordActionConfig = NonNullable<SchemaDiscordAccount["actions"]>;

export type DiscordIntentsConfig = NonNullable<SchemaDiscordAccount["intents"]>;

export type DiscordVoiceAutoJoinConfig = NonNullable<DiscordVoiceConfig["autoJoin"]>[number];

export type DiscordVoiceAllowedChannelConfig = NonNullable<
  DiscordVoiceConfig["allowedChannels"]
>[number];

export type DiscordVoiceMode = NonNullable<DiscordVoiceConfig["mode"]>;

export type DiscordVoiceRealtimeConsultPolicy = NonNullable<
  DiscordVoiceRealtimeConfig["consultPolicy"]
>;

export type DiscordVoiceRealtimeToolPolicy = NonNullable<DiscordVoiceRealtimeConfig["toolPolicy"]>;

export type DiscordVoiceRealtimeBootstrapContextFile = NonNullable<
  DiscordVoiceRealtimeConfig["bootstrapContextFiles"]
>[number];

export type DiscordVoiceRealtimeConfig = NonNullable<DiscordVoiceConfig["realtime"]>;

export type DiscordVoiceAgentSessionConfig = NonNullable<DiscordVoiceConfig["agentSession"]>;

export type DiscordVoiceConfig = Omit<NonNullable<SchemaDiscordAccount["voice"]>, "tts"> & {
  tts?: TtsConfig;
};

export type DiscordExecApprovalConfig = ChannelExecApprovalConfig<string> & {
  /** Delete approval DMs after approval, denial, or timeout. Default: false. */
  cleanupAfterResolve?: boolean;
};

export type DiscordAgentComponentsConfig = NonNullable<SchemaDiscordAccount["agentComponents"]>;

export type DiscordThreadBindingsConfig = SessionThreadBindingsConfig;

export type DiscordSlashCommandConfig = NonNullable<SchemaDiscordAccount["slashCommand"]>;

export type DiscordThreadConfig = NonNullable<SchemaDiscordAccount["thread"]>;

export type DiscordAutoPresenceConfig = NonNullable<SchemaDiscordAccount["autoPresence"]> & {
  /** @deprecated Doctor-only legacy input. */
  exhaustedText?: string;
};

type DiscordCommonConfig = Omit<
  CommonChannelMessagingConfig<string[], string, string, DiscordChannelStreamingConfig>,
  "groupAllowFrom"
>;

export type DiscordAccountConfig = Omit<
  SchemaDiscordAccount,
  keyof DiscordCommonConfig | "voice" | "guilds" | "pluralkit" | "autoPresence" | "execApprovals"
> &
  DiscordCommonConfig &
  ChannelBotInteractionConfig &
  ChannelReactionConfig<never, never, string> & {
    guilds?: Record<string, DiscordGuildEntry>;
    voice?: DiscordVoiceConfig;
    pluralkit?: DiscordPluralKitConfig;
    autoPresence?: DiscordAutoPresenceConfig;
    execApprovals?: DiscordExecApprovalConfig;
  };

export type DiscordConfig = {
  accounts?: Record<string, DiscordAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & DiscordAccountConfig;
