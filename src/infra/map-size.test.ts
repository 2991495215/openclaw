import { describe, expect, it } from "vitest";
import { getOrCreateInnerMap, pruneMapToMaxSize } from "./map-size.js";

describe("pruneMapToMaxSize", () => {
  const entries = [
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ] as const;

  it.each([
    {
      name: "floors fractional limits and keeps newest entries",
      maxSize: 2.9,
      expected: [
        ["b", 2],
        ["c", 3],
      ],
    },
    { name: "clears maps for zero limits", maxSize: 0, expected: [] },
    { name: "leaves maps untouched for NaN limits", maxSize: Number.NaN, expected: entries },
    {
      name: "leaves maps untouched for positive infinity limits",
      maxSize: Number.POSITIVE_INFINITY,
      expected: entries,
    },
    {
      name: "clears maps for negative infinity limits",
      maxSize: Number.NEGATIVE_INFINITY,
      expected: [],
    },
    { name: "leaves undersized maps untouched", maxSize: 5, expected: entries },
  ])("$name", ({ maxSize, expected }) => {
    const map = new Map(entries);
    pruneMapToMaxSize(map, maxSize);
    expect([...map.entries()]).toEqual(expected);
  });
});

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
