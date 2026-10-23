import type { SessionHovercardInput } from "./session-hovercard-solid.tsx";

export function hasSessionHovercardPullRequests(
  snapshot: SessionHovercardInput["pullRequests"],
): boolean {
  return Boolean(
    snapshot &&
    (snapshot.pullRequests.length > 0 ||
      (snapshot.taskPullRequests?.length ?? 0) > 0 ||
      snapshot.branch ||
      snapshot.status !== "ready"),
  );
}

export function hasSessionHovercardContent(input: SessionHovercardInput): boolean {
  return Boolean(
    input.row || hasSessionHovercardPullRequests(input.pullRequests) || input.progressCard,
  );
}
