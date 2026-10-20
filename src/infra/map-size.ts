/** Return a native Map or WeakMap owner's inner map, allocating it only when absent. */
export function getOrCreateInnerMap<Owner, Key, Value>(
  owners: {
    get(owner: Owner): Map<Key, Value> | undefined;
    set(owner: Owner, values: Map<Key, Value>): unknown;
  },
  owner: Owner,
): Map<Key, Value> {
  let values = owners.get(owner);
  if (!values) {
    values = new Map();
    owners.set(owner, values);
  }
  return values;
}

/** Prunes a Map in insertion order until it fits the requested maximum size. */
export function pruneMapToMaxSize<K, V>(map: Map<K, V>, maxSize: number): void {
  if (Number.isNaN(maxSize) || maxSize === Number.POSITIVE_INFINITY) {
    // Treat "unknown" or unlimited sizes as no-op so callers can wire optional caps directly.
    return;
  }
  const limit = Math.max(0, Math.floor(maxSize));
  if (limit <= 0) {
    map.clear();
    return;
  }

  // Reuse the insertion-order cursor so bulk pruning does not restart at deleted entries.
  for (const key of map.keys()) {
    if (map.size <= limit) {
      break;
    }
    map.delete(key);
  }
}
