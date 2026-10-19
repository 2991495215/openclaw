export const SESSION_NAVIGATION_ACTION_KINDS = [
  "copy-session-id",
  "copy-session-link",
  "copy-session-preview-link",
  "copy-markdown",
  "open-new-tab",
  "open-new-window",
  "split-right",
  "split-below",
] as const;

export type SessionNavigationActionKind = (typeof SESSION_NAVIGATION_ACTION_KINDS)[number];

export function isSessionNavigationAction(action: {
  kind: string;
}): action is { kind: SessionNavigationActionKind } {
  return SESSION_NAVIGATION_ACTION_KINDS.some((kind) => kind === action.kind);
}
