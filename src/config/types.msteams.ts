import type { z } from "zod";
import type { MSTeamsConfigSchema } from "../../extensions/msteams/config-api.js";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type { ChannelPreviewStreamingConfig } from "./types.base.js";
import type {
  CommonChannelGroupConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";

type SchemaMSTeamsConfig = SchemaContract<z.input<typeof MSTeamsConfigSchema>>;
type SchemaMSTeamsTeam = NonNullable<NonNullable<SchemaMSTeamsConfig["teams"]>[string]>;
type MSTeamsCommonConfig = Omit<
  CommonChannelMessagingConfig<string[], string, string, ChannelPreviewStreamingConfig>,
  "mentionPatterns" | "name" | "replyToMode"
>;

export type MSTeamsWebhookConfig = NonNullable<SchemaMSTeamsConfig["webhook"]> & {
  /** @deprecated Type-only until the next SDK major; Doctor migrates this to legacyWebhook.port. */
  port?: number;
};

export type MSTeamsCloudName = NonNullable<SchemaMSTeamsConfig["cloud"]>;
export type MSTeamsSsoConfig = NonNullable<SchemaMSTeamsConfig["sso"]>;
export type MSTeamsReplyStyle = NonNullable<SchemaMSTeamsConfig["replyStyle"]>;

export type MSTeamsChannelConfig = Omit<
  NonNullable<NonNullable<SchemaMSTeamsTeam["channels"]>[string]>,
  "tools" | "toolsBySender"
> &
  Pick<CommonChannelGroupConfig, "tools" | "toolsBySender">;

export type MSTeamsTeamConfig = MSTeamsChannelConfig & {
  channels?: Record<string, MSTeamsChannelConfig>;
};

export type MSTeamsConfig = Omit<
  SchemaMSTeamsConfig,
  keyof MSTeamsCommonConfig | "accounts" | "teams" | "webhook"
> &
  MSTeamsCommonConfig & {
    webhook?: MSTeamsWebhookConfig;
    teams?: Record<string, MSTeamsTeamConfig>;
    accounts?: Record<
      string,
      Omit<MSTeamsConfig, "accounts" | "defaultAccount"> & { name?: string }
    >;
  };
