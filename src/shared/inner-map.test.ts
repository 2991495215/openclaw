import { expect, it } from "vitest";
import { getOrCreateInnerMap } from "./inner-map.js";

it("reuses only the exact owner's map and creates a fresh map after its slot is retired", () => {
  const owners = new WeakMap<object, Map<string, string>>();
  const first = {};
  const second = {};
  const firstMap = getOrCreateInnerMap(owners, first);
  firstMap.set("key", "first");
  const secondMap = getOrCreateInnerMap(owners, second);
  secondMap.set("key", "second");
  expect(getOrCreateInnerMap(owners, first)).toBe(firstMap);
  expect(firstMap.get("key")).toBe("first");
  expect(secondMap.get("key")).toBe("second");
  owners.delete(first);
  expect(getOrCreateInnerMap(owners, first).size).toBe(0);
  expect(getOrCreateInnerMap(owners, second)).toBe(secondMap);
});

it("retains native Map key equality and object inner keys", () => {
  const owners = new Map<number, Map<object, string>>();
  const key = {};
  const values = getOrCreateInnerMap(owners, Number.NaN);
  values.set(key, "value");
  expect(getOrCreateInnerMap(owners, Number.NaN).get(key)).toBe("value");
  expect(getOrCreateInnerMap(owners, 1)).not.toBe(values);
});
