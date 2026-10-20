/** Return the inner map for an owner, allocating it only when absent. */
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
