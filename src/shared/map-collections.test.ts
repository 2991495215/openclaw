import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteMapCollectionEntry,
  getOrCreateMapValue,
  readUnexpiredMapEntry,
} from "./map-collections.js";

afterEach(() => vi.restoreAllMocks());

describe("getOrCreateMapValue", () => {
  it("keeps existing falsy values and creates each missing key once", () => {
    const map = new Map<string, number>([["zero", 0]]);
    let calls = 0;
    const create = () => ++calls;
    expect(getOrCreateMapValue(map, "zero", create)).toBe(0);
    expect(getOrCreateMapValue(map, "one", create)).toBe(1);
    expect(getOrCreateMapValue(map, "one", create)).toBe(1);
    expect(calls).toBe(1);
    expect([...map]).toEqual([
      ["zero", 0],
      ["one", 1],
    ]);
  });

  it("retains the same rejected promise for an object key", async () => {
    const map = new WeakMap<object, Promise<never>>();
    const key = {};
    const failure = new Error("load failed");
    const promise = getOrCreateMapValue(map, key, () => Promise.reject(failure));
    await expect(promise).rejects.toBe(failure);
    expect(getOrCreateMapValue(map, key, () => Promise.reject(new Error("unexpected")))).toBe(
      promise,
    );
    expect(map.has({})).toBe(false);
  });

  it("does not install a value when its synchronous factory throws", () => {
    const map = new Map<string, object>();
    const failure = new Error("creation failed");
    expect(() =>
      getOrCreateMapValue(map, "key", () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(map.has("key")).toBe(false);
    expect(getOrCreateMapValue(map, "key", () => ({ ready: true }))).toEqual({ ready: true });
  });
});

describe("readUnexpiredMapEntry", () => {
  it("returns the original live entry without recency promotion and removes entries at expiry", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    const live = { expiresAt: 101, value: undefined };
    const map = new Map([
      ["live", live],
      ["expired", { expiresAt: 100, value: undefined }],
    ]);
    expect(readUnexpiredMapEntry(map, "missing")).toBeUndefined();
    expect(now).not.toHaveBeenCalled();
    expect(readUnexpiredMapEntry(map, "live")).toBe(live);
    expect([...map.keys()]).toEqual(["live", "expired"]);
    expect(readUnexpiredMapEntry(map, "expired")).toBeUndefined();
    expect(map.has("expired")).toBe(false);
    expect(now).toHaveBeenCalledTimes(2);
  });
});

describe("deleteMapCollectionEntry", () => {
  it("removes Set items and prunes only the empty current bucket", () => {
    const map = new Map([
      ["key", new Set(["a", "b"])],
      ["empty", new Set<string>()],
    ]);
    deleteMapCollectionEntry(map, "missing", "a");
    deleteMapCollectionEntry(map, "key", "a");
    expect([...(map.get("key") ?? [])]).toEqual(["b"]);
    deleteMapCollectionEntry(map, "empty", "absent");
    expect(map.has("empty")).toBe(false);
    deleteMapCollectionEntry(map, "key", "b");
    expect(map.size).toBe(0);
  });

  it("deletes inner Map keys without confusing them with their values", () => {
    const item = {};
    const map = new Map([["key", new Map([[item, "value"]])]]);
    deleteMapCollectionEntry(map, "key", {});
    expect(map.get("key")?.get(item)).toBe("value");
    deleteMapCollectionEntry(map, "key", item);
    expect(map.has("key")).toBe(false);
  });
});
