import { hasNodeErrorCode as hasErrnoCode } from "@openclaw/fs-safe/path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
export { isNodeError as isErrno } from "@openclaw/fs-safe/path";
export { hasErrnoCode };

/** Node absence only; fs-safe's separate not-found code is not a Node filesystem error. */
export function isMissingNodePathError(error: unknown): boolean {
  const code = extractErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Classifies missing filesystem paths across Node and fs-safe boundaries. */
export function isMissingPathError(err: unknown): boolean {
  return (
    hasErrnoCode(err, "ENOENT") || hasErrnoCode(err, "ENOTDIR") || hasErrnoCode(err, "not-found")
  );
}
