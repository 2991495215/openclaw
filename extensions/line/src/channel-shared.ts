import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { buildChannelMetaFromManifest } from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import pluginPackage from "../package.json" with { type: "json" };
import { hasLineCredentials } from "./account-helpers.js";
import { lineConfigAdapter } from "./config-adapter.js";
import { LineChannelConfigSchema } from "./config-schema.js";
import type { ResolvedLineAccount } from "./types.js";

export const lineChannelPluginCommon = {
  meta: buildChannelMetaFromManifest({
    ...pluginPackage.openclaw.channel,
    blurb: "LINE Messaging API bot for Japan/Taiwan/Thailand markets.",
    systemImage: "message.fill",
    order: undefined,
  }),
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.line"] },
  configSchema: LineChannelConfigSchema,
  config: {
    ...lineConfigAdapter,
    isConfigured: (account: ResolvedLineAccount) => hasLineCredentials(account),
    describeAccount: (account: ResolvedLineAccount) =>
      describeWebhookAccountSnapshot({
        account,
        configured: hasLineCredentials(account),
        extra: {
          tokenSource: account.tokenSource ?? undefined,
          signingSecretSource: account.signingSecretSource ?? undefined,
          tokenStatus: account.tokenStatus,
          signingSecretStatus: account.signingSecretStatus,
        },
      }),
  },
} satisfies Pick<
  ChannelPlugin<ResolvedLineAccount>,
  "meta" | "capabilities" | "reload" | "configSchema" | "config"
>;
