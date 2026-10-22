import { createDeferred } from "@solidjs/signals";
import { createMemo } from "solid-js";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

/** Observe admitted reads without owning requests, errors, or recovery. */
export function createSessionWorkspaceRead(workspace: () => SessionWorkspaceProps) {
  const owner = createMemo(() => workspace().readState);
  // Files and artifacts are admitted independently by the same workspace owner.
  const result = createMemo(
    () => ({
      owner: owner(),
      files: workspace().readResult,
      artifacts: workspace().readState?.artifacts?.readResult,
    }),
    {
      equals: (previous, next) =>
        previous.owner === next.owner &&
        previous.files === next.files &&
        previous.artifacts === next.artifacts,
    },
  );
  const location = createMemo(() =>
    JSON.stringify([
      workspace().sessionKey,
      workspace().connectionEpoch,
      workspace().browserPath,
      workspace().browserSearch,
    ]),
  );
  const scope = createMemo(() => ({ owner: owner(), location: location() }));
  // Preserve usable catalog rows while the owner records failures and schedules recovery.
  const read = createDeferred(async () => {
    const pending = result();
    await Promise.all([pending.files, pending.artifacts]);
    return null;
  });
  return { read, scope };
}
