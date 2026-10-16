import type { z } from "zod";
import type { SignalConfigSchema } from "../../extensions/signal/config-api.js";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type {
  ChannelReactionConfig,
  CommonChannelGroupConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";

type SchemaSignalAccount = SchemaContract<
  NonNullable<NonNullable<z.output<typeof SignalConfigSchema>["accounts"]>[string]>
>;
type SignalCommonConfig = Omit<CommonChannelMessagingConfig, "mentionPatterns">;
type SchemaSignalGroup = NonNullable<NonNullable<SchemaSignalAccount["groups"]>[string]>;

export type SignalReactionNotificationMode = NonNullable<
  SchemaSignalAccount["reactionNotifications"]
>;
export type SignalReactionLevel = NonNullable<SchemaSignalAccount["reactionLevel"]>;
export type SignalTransportConfig = NonNullable<SchemaSignalAccount["transport"]>;
export type SignalGroupConfig = Omit<SchemaSignalGroup, "tools" | "toolsBySender"> &
  Pick<CommonChannelGroupConfig, "tools" | "toolsBySender">;

export type SignalAccountConfig = Omit<SchemaSignalAccount, keyof SignalCommonConfig | "groups"> &
  SignalCommonConfig &
  ChannelReactionConfig<SignalReactionNotificationMode, SignalReactionLevel, never, true> & {
    groups?: Record<string, SignalGroupConfig>;
  };

export type SignalConfig = {
  accounts?: Record<string, SignalAccountConfig>;
  defaultAccount?: string;
} & SignalAccountConfig;
