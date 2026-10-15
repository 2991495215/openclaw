import { describe, expect, it } from "vitest";
import {
  pruneExpiredMapEntries,
  readExpiringMapEntry,
  readLruMapEntry,
  writeLruMapEntry,
} from "./map-cache.js";

describe("caller-owned cache maps", () => {
  it.each([false, 0, null, ""])("touches a defined falsy value %s", (value) => {
    const entries = new Map<string, unknown>([
      ["a", value],
      ["b", "second"],
    ]);
    expect(readLruMapEntry(entries, "a")).toBe(value);
    writeLruMapEntry(entries, "c", "third", 2);
    expect([...entries.keys()]).toEqual(["a", "c"]);
  });

  it("retains recently read and rewritten entries when bounding the map", () => {
    const entries = new Map<string, string>();
    writeLruMapEntry(entries, "a", "first", 2);
    writeLruMapEntry(entries, "b", "second", 2);
    expect(readLruMapEntry(entries, "a")).toBe("first");
    writeLruMapEntry(entries, "c", "third", 2);
    expect([...entries.keys()]).toEqual(["a", "c"]);
    writeLruMapEntry(entries, "a", "updated", 2);
    expect([...entries]).toEqual([
      ["c", "third"],
      ["a", "updated"],
    ]);
  });

  it("expires facts at their boundary without refreshing or reordering live entries", () => {
    const live = { expiresAt: 20 };
    const entries = new Map([
      ["live", live],
      ["old", { expiresAt: 10 }],
      ["other", { expiresAt: 30 }],
    ]);
    expect(readExpiringMapEntry(entries, "live", 10)).toBe(live);
    expect([...entries.keys()]).toEqual(["live", "old", "other"]);
    expect(readExpiringMapEntry(entries, "old", 10)).toBeUndefined();
    expect(entries.has("old")).toBe(false);
    pruneExpiredMapEntries(entries, 20);
    expect([...entries.keys()]).toEqual(["other"]);
  });
});
