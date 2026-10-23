import { expect, it } from "vitest";
import { createWeakOwnerIds, getOrCreateWeakOwnerMap } from "./weak-owner-map.js";

it("reuses only the exact owner's map and creates a fresh map after its slot is retired", () => {
  const owners = new WeakMap<object, Map<string, string>>();
  const first = {};
  const second = {};
  const firstMap = getOrCreateWeakOwnerMap(owners, first);
  firstMap.set("key", "first");
  const secondMap = getOrCreateWeakOwnerMap(owners, second);
  secondMap.set("key", "second");
  expect(getOrCreateWeakOwnerMap(owners, first)).toBe(firstMap);
  expect(firstMap.get("key")).toBe("first");
  expect(secondMap.get("key")).toBe("second");
  owners.delete(first);
  expect(getOrCreateWeakOwnerMap(owners, first).size).toBe(0);
  expect(getOrCreateWeakOwnerMap(owners, second)).toBe(secondMap);
});

it("keeps numeric owner spaces independent and binds aliases without allocating an ID", () => {
  const first = createWeakOwnerIds();
  const second = createWeakOwnerIds(1);
  const owner = {};
  const alias = {};
  expect(first.getId(owner)).toBe(0);
  expect(first.getId(owner)).toBe(0);
  expect(first.getId({})).toBe(1);
  expect(second.getId(owner)).toBe(1);
  first.setId(alias, 0);
  expect(first.getId(alias)).toBe(0);
  expect(first.getId({})).toBe(2);
  first.setId(alias, 11);
  expect(first.getId(alias)).toBe(11);
  expect(first.getId({})).toBe(3);
});
