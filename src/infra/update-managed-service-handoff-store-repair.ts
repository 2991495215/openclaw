// Owns recovery of an unusable managed-handoff lease store.
import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";

/** Retain unusable coordination state for diagnostics before the caller provisions its replacement. */
export function quarantineManagedHandoffStore(databasePath: string): void {
  const retained = `${databasePath}.unsafe-file.${Date.now()}`;
  try {
    fs.renameSync(databasePath, retained);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    // Removing the blocker matters more than keeping a copy of it: a rename that
    // cannot land must not put the host back into a permanent refusal.
    try {
      fs.rmSync(databasePath, { force: true });
    } catch {
      return;
    }
    console.warn(
      `[openclaw] managed handoff lease store was unsafe-file; removed ${path.basename(databasePath)} to restore updates`,
    );
    return;
  }
  console.warn(
    `[openclaw] managed handoff lease store was unsafe-file; retained it as ${path.basename(retained)} and started a new one`,
  );
}
