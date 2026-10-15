import { pruneMapToMaxSize } from "./map-size.js";

/** Touch a hit so insertion-order pruning retains recently used keys. */
export function readLruMapEntry<T>(cache: Map<string, T>, key: string): T | undefined {
  const entry = cache.get(key);
  if (entry !== undefined) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

export function writeLruMapEntry<T>(
  cache: Map<string, T>,
  key: string,
  entry: T,
  maxEntries: number,
): void {
  cache.delete(key);
  cache.set(key, entry);
  pruneMapToMaxSize(cache, maxEntries);
}

/** Read one expiring fact without changing the cache's eviction order. */
export function readExpiringMapEntry<T extends { expiresAt: number }>(
  cache: Map<string, T>,
  key: string,
  now = Date.now(),
): T | undefined {
  const entry = cache.get(key);
  if (entry && entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

export function pruneExpiredMapEntries<T extends { expiresAt: number }>(
  cache: Map<string, T>,
  now: number,
): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}
