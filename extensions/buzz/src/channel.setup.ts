import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { buildChannelMetaFromManifest, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import pluginPackage from "../package.json" with { type: "json" };
import { BuzzConfigSchema } from "./config-schema.js";
import { buzzSetupContract } from "./setup-core.js";
import { buzzSetupWizard } from "./setup-surface.js";
import {
  listBuzzAccountIds,
  resolveBuzzAccount,
  resolveDefaultBuzzAccountId,
  type ResolvedBuzzAccount,
} from "./types.js";

export const buzzSetupPlugin: ChannelPlugin<ResolvedBuzzAccount> = {
  id: "buzz",
  meta: buildChannelMetaFromManifest(pluginPackage.openclaw.channel),
  capabilities: { chatTypes: ["group"], threads: true },
  reload: { configPrefixes: ["channels.buzz"], accountScopedRestart: true },
  configSchema: BuzzConfigSchema,
  setupContract: buzzSetupContract,
  setupWizard: buzzSetupWizard,
  config: {
    listAccountIds: listBuzzAccountIds,
    resolveAccount: (cfg, accountId) => resolveBuzzAccount({ cfg, accountId }),
    defaultAccountId: resolveDefaultBuzzAccountId,
    isConfigured: (account) => account.configured,
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: account.configured,
        extra: { baseUrl: account.relayUrl, publicKey: account.publicKey },
      }),
  },
};
