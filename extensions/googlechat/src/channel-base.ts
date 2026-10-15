import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelMetaFromManifest, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import pluginPackage from "../package.json" with { type: "json" };
import {
  type GoogleChatConfigAccessorAccount,
  inspectGoogleChatAccount,
  isGoogleChatAccountConfigured,
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatConfigAccessorAccount,
  resolveGoogleChatAccount,
  type ResolvedGoogleChatAccount,
} from "./accounts.js";
import { googlechatSetupContract } from "./setup-core.js";
import { googlechatSetupWizard } from "./setup-surface.js";

export const GOOGLECHAT_CHANNEL_ID = "googlechat" as const;

export const formatGoogleChatAllowFromEntry = (entry: string) =>
  normalizeLowercaseStringOrEmpty(
    entry
      .trim()
      .replace(/^(googlechat|google-chat|gchat):/i, "")
      .replace(/^user:/i, "")
      .replace(/^users\//i, ""),
  );

const googleChatConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedGoogleChatAccount,
  GoogleChatConfigAccessorAccount
>({
  sectionKey: GOOGLECHAT_CHANNEL_ID,
  listAccountIds: listGoogleChatAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
  resolveAccessorAccount: resolveGoogleChatConfigAccessorAccount,
  defaultAccountId: resolveDefaultGoogleChatAccountId,
  clearBaseFields: [
    "serviceAccount",
    "serviceAccountFile",
    "audienceType",
    "audience",
    "webhookPath",
    "webhookUrl",
    "botUser",
    "name",
  ],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: formatGoogleChatAllowFromEntry,
    }),
  resolveDefaultTo: (account) => account.config.defaultTo,
});

export const googlechatSetupPlugin: ChannelPlugin<ResolvedGoogleChatAccount> = {
  id: GOOGLECHAT_CHANNEL_ID,
  meta: buildChannelMetaFromManifest(pluginPackage.openclaw.channel),
  setupContract: googlechatSetupContract,
  setupWizard: googlechatSetupWizard,
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    threads: true,
    // Inbound attachment download remains supported even though service-account
    // authentication cannot use Google Chat's user-auth-only upload endpoint.
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.googlechat"] },
  config: {
    ...googleChatConfigAdapter,
    inspectAccount: adaptScopedAccountAccessor(inspectGoogleChatAccount),
    isConfigured: isGoogleChatAccountConfigured,
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: isGoogleChatAccountConfigured(account),
        extra: {
          credentialSource: account.credentialSource,
          tokenStatus: account.tokenStatus,
        },
      }),
  },
};
