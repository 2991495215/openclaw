// Small collection helpers for bounded in-memory plugin caches.

export { pruneMapToMaxSize } from "../infra/map-size.js";
export {
  readLruMapEntry,
  writeLruMapEntry,
  readExpiringMapEntry,
  pruneExpiredMapEntries,
} from "../infra/map-cache.js";
export { createStaleWhileRevalidateCache } from "../infra/stale-while-revalidate-cache.js";
