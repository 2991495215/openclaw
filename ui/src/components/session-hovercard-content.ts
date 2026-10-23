import type { ProgressCard } from "@openclaw/gateway-protocol";
import type { ControlUiSessionPullRequestSnapshot } from "../../../src/gateway/control-ui-contract.js";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";

export function hasSessionHovercardPullRequests(
  snapshot: ControlUiSessionPullRequestSnapshot | undefined,
): boolean {
  return Boolean(
    snapshot &&
    (snapshot.pullRequests.length > 0 ||
      (snapshot.taskPullRequests?.length ?? 0) > 0 ||
      snapshot.branch ||
      snapshot.status !== "ready"),
  );
}

export function hasSessionHovercardContent(input: {
  row?: SidebarSessionHovercardRow;
  pullRequests?: ControlUiSessionPullRequestSnapshot;
  progressCard?: ProgressCard | null;
}): boolean {
  return Boolean(
    input.row || hasSessionHovercardPullRequests(input.pullRequests) || input.progressCard,
  );
}
