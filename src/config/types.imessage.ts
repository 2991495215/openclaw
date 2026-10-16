import type { z } from "zod";
import type { IMessageConfigSchema } from "../../extensions/imessage/config-api.js";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type {
  ChannelReactionConfig,
  CommonChannelGroupConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";

type SchemaIMessageAccount = SchemaContract<
  NonNullable<NonNullable<z.input<typeof IMessageConfigSchema>["accounts"]>[string]>
>;
type IMessageCommonConfig = Omit<CommonChannelMessagingConfig, "mentionPatterns" | "replyToMode">;
type SchemaIMessageGroup = NonNullable<NonNullable<SchemaIMessageAccount["groups"]>[string]>;

export type IMessageActionConfig = NonNullable<SchemaIMessageAccount["actions"]>;
export type IMessageReactionNotificationMode = NonNullable<
  SchemaIMessageAccount["reactionNotifications"]
>;
export type IMessageSendTransport = NonNullable<SchemaIMessageAccount["sendTransport"]>;

export type IMessageAccountConfig = Omit<
  SchemaIMessageAccount,
  keyof IMessageCommonConfig | "groups"
> &
  IMessageCommonConfig &
  ChannelReactionConfig<IMessageReactionNotificationMode> & {
    groups?: Record<
      string,
      Omit<SchemaIMessageGroup, "tools" | "toolsBySender"> &
        Pick<CommonChannelGroupConfig, "tools" | "toolsBySender">
    >;
  };

export type IMessageConfig = {
  accounts?: Record<string, IMessageAccountConfig>;
  defaultAccount?: string;
} & IMessageAccountConfig;
