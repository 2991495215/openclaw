import { resolveNonNegativeIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getOrCreateWeakOwnerMap } from "../../shared/weak-owner-map.js";
import { pruneMapToMaxSize } from "../map-size.js";

type CacheEntry<T> = {
  value: T;
  fetchedAt: number;
};

type DirectoryCacheKey = {
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  signature?: string | null;
  query?: string | null;
};

export function buildDirectoryCacheKey(key: DirectoryCacheKey): string {
  const signature = key.signature ?? "default";
  return `${key.channel}:${key.accountId ?? "default"}:${key.kind}:${signature}:query:${key.query ?? ""}`;
}

/** TTL and capacity are scoped to a config object reference. */
export class DirectoryCache<T> {
  private cachesByConfig = new WeakMap<OpenClawConfig, Map<string, CacheEntry<T>>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs: number, maxSize = 2000) {
    this.ttlMs = resolveNonNegativeIntegerOption(ttlMs, 0);
    this.maxSize = Math.max(1, resolveNonNegativeIntegerOption(maxSize, 2000));
  }

  get(key: string, cfg: OpenClawConfig): T | undefined {
    const entry = this.cachesByConfig.get(cfg)?.get(key);
    return entry && (this.ttlMs <= 0 || Date.now() - entry.fetchedAt < this.ttlMs)
      ? entry.value
      : undefined;
  }

  set(key: string, value: T, cfg: OpenClawConfig): void {
    const cache = getOrCreateWeakOwnerMap(this.cachesByConfig, cfg);
    // Refresh insertion order so active keys are less likely to be evicted.
    cache.delete(key);
    cache.set(key, { value, fetchedAt: Date.now() });
    pruneMapToMaxSize(cache, this.maxSize);
  }

  clearMatching(match: (key: string) => boolean, cfg: OpenClawConfig): void {
    const cache = this.cachesByConfig.get(cfg);
    if (!cache) {
      return;
    }
    for (const key of cache.keys()) {
      if (match(key)) {
        cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cachesByConfig = new WeakMap();
  }
}
