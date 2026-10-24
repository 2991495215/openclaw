/** Allocate stable weak object identities within one synchronous owner. */
export function createObjectIdAllocator(startAt = 0): (value: object) => number {
  const ids = new WeakMap<object, number>();
  let nextId = startAt;
  return (value) => {
    let id = ids.get(value);
    if (id === undefined) {
      id = nextId++;
      ids.set(value, id);
    }
    return id;
  };
}
