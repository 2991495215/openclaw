// Covers path guard helpers for platform and symlink errors.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  canAccess,
  canAccessSync,
  isPathInside,
  isPathStrictlyInside,
  normalizeWindowsPathForComparison,
  normalizeWindowsPathPreservingCase,
  pathEntryExists,
  readDirectoryEntriesSync,
  safeStat,
} from "./path-guards.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("filesystem discovery policies", () => {
  it("distinguishes entries from followed targets and returns typed directory entries", async () => {
    await withTestDir({ prefix: "openclaw-path-guards-" }, async (root) => {
      const file = path.join(root, "file");
      const directory = path.join(root, "directory");
      const link = path.join(root, "link");
      const dangling = path.join(root, "dangling");
      const missing = path.join(root, "missing");
      await fsPromises.writeFile(file, "fixture");
      await fsPromises.mkdir(directory);
      await fsPromises.symlink(file, link, "file");
      await fsPromises.symlink(missing, dangling, "file");

      expect(await pathEntryExists(dangling)).toBe(true);
      expect(await pathEntryExists(missing)).toBe(false);
      expect((await safeStat(link))?.isFile()).toBe(true);
      expect((await safeStat(directory))?.isDirectory()).toBe(true);
      expect(await safeStat(dangling)).toBeNull();
      expect(await safeStat(missing)).toBeNull();
      const entries = readDirectoryEntriesSync(root);
      expect(entries.map((entry) => entry.name).toSorted()).toEqual([
        "dangling",
        "directory",
        "file",
        "link",
      ]);
      expect(entries.find((entry) => entry.name === "directory")?.isDirectory()).toBe(true);
      expect(readDirectoryEntriesSync(missing)).toEqual([]);
      expect(readDirectoryEntriesSync(file)).toEqual([]);
    });
  });

  it("uses the requested access mode instead of substituting an existence check", async () => {
    await withTestDir({ prefix: "openclaw-access-" }, async (root) => {
      const file = path.join(root, "file");
      const missing = path.join(root, "missing");
      await fsPromises.writeFile(file, "fixture", { mode: 0o600 });
      expect(await canAccess(file, fs.constants.R_OK)).toBe(true);
      expect(canAccessSync(file, fs.constants.R_OK)).toBe(true);
      expect(await canAccess(missing)).toBe(false);
      expect(canAccessSync(missing)).toBe(false);
      if (process.platform !== "win32") {
        expect(await canAccess(file, fs.constants.X_OK)).toBe(false);
        expect(canAccessSync(file, fs.constants.X_OK)).toBe(false);
        await fsPromises.chmod(file, 0o700);
        expect(await canAccess(file, fs.constants.X_OK)).toBe(true);
        expect(canAccessSync(file, fs.constants.X_OK)).toBe(true);
      }
    });
  });

  it("propagates non-ENOENT entry failures rather than reporting absence", async () => {
    const failure = Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    vi.spyOn(fsPromises, "lstat").mockRejectedValue(failure);
    await expect(pathEntryExists("blocked/child")).rejects.toBe(failure);
  });
});

describe("normalizeWindowsPathForComparison", () => {
  it.each([
    ["\\\\?\\C:\\Users\\Peter/Repo", "c:\\users\\peter\\repo"],
    ["\\\\?\\UNC\\Server\\Share\\Folder", "\\\\server\\share\\folder"],
    ["\\\\?\\unc\\Server\\Share\\Folder", "\\\\server\\share\\folder"],
  ])("normalizes windows path %s", (input, expected) => {
    expect(normalizeWindowsPathForComparison(input)).toBe(expected);
  });
});

describe("normalizeWindowsPathPreservingCase", () => {
  it.each([
    ["\\\\?\\C:\\Users\\Peter/Repo", "C:\\Users\\Peter\\Repo"],
    ["\\\\?\\UNC\\Server\\Share\\Folder", "\\\\Server\\Share\\Folder"],
    ["\\\\?\\unc\\Server\\Share\\Folder", "\\\\Server\\Share\\Folder"],
    ["C:\\Users\\User\\OpenClaw\\src/Components", "C:\\Users\\User\\OpenClaw\\src\\Components"],
    ["C:\\Users\\User\\OpenClaw  ", "C:\\Users\\User\\OpenClaw  "],
  ])("normalizes windows path %s without lowercasing", (input, expected) => {
    expect(normalizeWindowsPathPreservingCase(input)).toBe(expected);
  });
});

describe("isPathInside", () => {
  it.each([
    ["/workspace/root", "/workspace/root", true],
    ["/workspace/root", "/workspace/root/nested/file.txt", true],
    ["/workspace/root", "/workspace/root/..cache/cache.json", true],
    ["/workspace/root", "/workspace/root/../escape.txt", false],
    ["/workspace/root", "/workspace/rootless/file.txt", false],
    ["/workspace/root", "/workspace/root/a/..", true],
    ["/", "/anything/at/all", true],
    ["foo", "foo/bar", true],
    ["foo", "../escape", false],
  ])("checks posix containment %s -> %s", (basePath, targetPath, expected) => {
    expect(isPathInside(basePath, targetPath)).toBe(expected);
  });

  it("uses win32 path semantics for windows containment checks", () => {
    mockProcessPlatform("win32");

    for (const [basePath, targetPath, expected] of [
      [String.raw`C:\workspace\root`, String.raw`C:\workspace\root`, true],
      [String.raw`C:\workspace\root`, String.raw`C:\workspace\root\Nested\File.txt`, true],
      [String.raw`C:\workspace\root`, String.raw`C:\workspace\root\..file.txt`, true],
      [String.raw`C:\workspace\root`, String.raw`C:\workspace\root\..\escape.txt`, false],
      [String.raw`C:\workspace\root`, String.raw`D:\workspace\root\file.txt`, false],
    ] as const) {
      expect(isPathInside(basePath, targetPath)).toBe(expected);
    }
  });
});

describe("isPathStrictlyInside", () => {
  it.each([
    ["/workspace/root", "/workspace/root", false],
    ["/workspace/root", "/workspace/root/child", true],
    ["/workspace/root", "/workspace/root/..cache/cache.json", true],
    ["/workspace/root", "/workspace/root/../escape", false],
  ])("checks strict posix containment %s -> %s", (basePath, targetPath, expected) => {
    expect(isPathStrictlyInside(basePath, targetPath)).toBe(expected);
  });

  it("uses win32 path semantics for strict containment checks", () => {
    mockProcessPlatform("win32");

    for (const [basePath, targetPath, expected] of [
      [String.raw`C:\workspace\root`, String.raw`C:\workspace\root`, false],
      [String.raw`C:\workspace\root`, String.raw`C:\workspace\root\..cache\file.txt`, true],
      [String.raw`C:\workspace\root`, String.raw`D:\workspace\root\file.txt`, false],
    ] as const) {
      expect(isPathStrictlyInside(basePath, targetPath)).toBe(expected);
    }
  });
});
