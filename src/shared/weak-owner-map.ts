/** Return the inner map for an object owner, allocating it only when absent. */
export function getOrCreateWeakOwnerMap<Owner extends object, Key, Value>(
  owners: WeakMap<Owner, Map<Key, Value>>,
  owner: Owner,
): Map<Key, Value> {
  let values = owners.get(owner);
  if (!values) {
    values = new Map();
    owners.set(owner, values);
  }
  return values;
}

/** Creates a private numeric identity space with explicit alias binding. */
export function createWeakOwnerIds(firstId = 0) {
  const ids = new WeakMap<object, number>();
  let nextId = firstId;
  return {
    getId: (owner: object): number => {
      const existing = ids.get(owner);
      if (existing !== undefined) {
        return existing;
      }
      const id = nextId++;
      ids.set(owner, id);
      return id;
    },
    setId: (owner: object, id: number): void => {
      ids.set(owner, id);
    },
  };
}
