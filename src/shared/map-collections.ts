/** Returns the existing value or installs one synchronously, including a pending promise. */
export function getOrCreateMapValue<K, V>(
  map: { get(key: K): V | undefined; set(key: K, value: V): unknown },
  key: K,
  create: () => V,
): V {
  const existing = map.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = create();
  map.set(key, created);
  return created;
}

/** Reads an expiring entry without changing the recency of a live hit. */
export function readUnexpiredMapEntry<K, V extends { expiresAt: number }>(
  map: Map<K, V>,
  key: K,
): V | undefined {
  const entry = map.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return entry;
}

/** Removes an item from the current bucket and prunes the key when that bucket is empty. */
export function deleteMapCollectionEntry<K, T>(
  map: {
    get(key: K): { delete(item: T): unknown; size: number } | undefined;
    delete(key: K): unknown;
  },
  key: K,
  item: T,
): void {
  const bucket = map.get(key);
  if (!bucket) {
    return;
  }
  bucket.delete(item);
  if (bucket.size === 0) {
    map.delete(key);
  }
}
