import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { listBundledChannelCatalogEntries } from "./bundled-channel-catalog-read.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "./ids.js";
import { buildManifestChannelMeta } from "./plugins/channel-meta.js";
import type { ChannelMeta } from "./plugins/types.core.js";

type ChatChannelMeta = ChannelMeta;
const CHAT_CHANNEL_ID_SET = new Set<string>(CHAT_CHANNEL_ORDER);
let chatChannelMetaCache:
  | { cacheKey: string; metaById: Partial<Record<ChatChannelId, ChatChannelMeta>> }
  | undefined;

function getChatChannelMetaById(): Partial<Record<ChatChannelId, ChatChannelMeta>> {
  const cacheKey = resolveBundledPluginsDir(process.env) ?? "";
  if (chatChannelMetaCache?.cacheKey !== cacheKey) {
    const entries: Partial<Record<ChatChannelId, ChatChannelMeta>> = {};
    for (const entry of listBundledChannelCatalogEntries()) {
      // The catalog can contain non-chat bundled channels. Keep this map restricted to the
      // generated chat-channel order so setup/status views stay stable.
      const id = normalizeOptionalString(entry.id);
      if (!id || !CHAT_CHANNEL_ID_SET.has(id)) {
        continue;
      }
      const channel = entry.channel;
      const label = normalizeOptionalString(channel.label);
      if (!label) {
        throw new Error(`Missing label for bundled chat channel "${id}"`);
      }
      entries[id] = buildManifestChannelMeta({
        id,
        channel,
        label,
        selectionLabel: normalizeOptionalString(channel.selectionLabel) || label,
        docsPath: normalizeOptionalString(channel.docsPath) || `/channels/${id}`,
        docsLabel: normalizeOptionalString(channel.docsLabel),
        blurb: normalizeOptionalString(channel.blurb) || "",
        detailLabel: normalizeOptionalString(channel.detailLabel),
        systemImage: normalizeOptionalString(channel.systemImage),
        arrayFieldMode: "non-empty",
      });
    }
    chatChannelMetaCache = { cacheKey, metaById: Object.freeze(entries) };
  }
  return chatChannelMetaCache.metaById;
}

export function listChatChannels(): ChatChannelMeta[] {
  const metaById = getChatChannelMetaById();
  return CHAT_CHANNEL_ORDER.map((id) => metaById[id]).filter((meta): meta is ChatChannelMeta =>
    Boolean(meta),
  );
}

/** Drift-tolerant lookup: undefined when the id is missing from the bundled catalog. */
export function findChatChannelMeta(id: ChatChannelId): ChatChannelMeta | undefined {
  return getChatChannelMetaById()[id];
}

/**
 * Returns metadata for one built-in chat channel id.
 * Shipped plugin-SDK contract: callers pass bundled ids, so absence is an invariant
 * violation; drift-tolerant core paths use findChatChannelMeta instead.
 */
export function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta {
  return expectDefined(findChatChannelMeta(id), `chat channel meta for ${id}`);
}
