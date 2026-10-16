// Exposes generic path guard helpers with fs-safe defaults.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode, isPathInside } from "@openclaw/fs-safe/path";

// Generic path guard facade for containment checks and safe relative paths.
export {
  hasNodeErrorCode,
  isNotFoundPathError,
  normalizeWindowsPathForComparison,
  safeStatSync,
} from "@openclaw/fs-safe/path";
export { isPathInside };

/** Optional discovery directories may be absent or unreadable. */
export function readDirectoryEntriesSync(filePath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(filePath, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Inspect the entry itself, including dangling links; only ENOENT means absent. */
export async function pathEntryExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.lstat(filePath);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/** Best-effort discovery probe; inaccessible candidates are not usable. */
export async function canAccess(filePath: string, mode?: number): Promise<boolean> {
  try {
    await fsPromises.access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

export function canAccessSync(filePath: string, mode?: number): boolean {
  try {
    fs.accessSync(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

/** Follow links for optional discovery; filesystem errors make the candidate unavailable. */
export async function safeStat(filePath: string): Promise<fs.Stats | null> {
  return fsPromises.stat(filePath).catch(() => null);
}

/** Returns true only when target is a descendant of root, not root itself. */
export function isPathStrictlyInside(root: string, target: string): boolean {
  return isPathInside(root, target) && !isPathInside(target, root);
}

/**
 * Normalize a Windows path for boundary math whose result is handed back to callers.
 *
 * Unlike `normalizeWindowsPathForComparison`, this preserves case: `path.win32.relative`
 * already matches roots case-insensitively, so lowercasing only corrupts the returned
 * relative path — and callers create files from it on a case-preserving filesystem.
 * Extended-length prefix stripping stays, or `\\?\`-prefixed inputs read as boundary escapes.
 */
export function normalizeWindowsPathPreservingCase(input: string): string {
  // Mirrors normalizeWindowsPathForComparison step for step, minus the lowercasing,
  // so the only behavior that shifts is the case of the characters handed back.
  // fs-safe 0.5.2 keeps surrounding whitespace (it can disguise reserved names),
  // so this mirror must not trim either.
  const normalized = path.win32.normalize(input);
  if (!normalized.startsWith("\\\\?\\")) {
    return normalized;
  }
  const withoutPrefix = normalized.slice(4);
  return withoutPrefix.toUpperCase().startsWith("UNC\\")
    ? `\\\\${withoutPrefix.slice(4)}`
    : withoutPrefix;
}
