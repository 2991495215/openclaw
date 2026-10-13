import { parseSlackTarget, slackTargetsMatch } from "./target-parsing.js";

function matchesResolvedUserTarget(target: string, currentMessagingTarget: string): boolean {
  const resolvedId = target.trim();
  if (!/^[UW][A-Z0-9]+$/i.test(resolvedId)) {
    return false;
  }
  const currentTarget = parseSlackTarget(currentMessagingTarget);
  return (
    currentTarget?.kind === "user" && currentTarget.id.toLowerCase() === resolvedId.toLowerCase()
  );
}

export function slackContextTargetsMatch(
  target: string,
  context: {
    currentChannelId?: string;
    currentMessagingTarget?: string;
  },
): boolean {
  return Boolean(
    (context.currentMessagingTarget &&
      (slackTargetsMatch(target, context.currentMessagingTarget) ||
        // Core target resolution removes the user: prefix before auto-thread selection.
        matchesResolvedUserTarget(target, context.currentMessagingTarget))) ||
    (context.currentChannelId && slackTargetsMatch(target, context.currentChannelId)),
  );
}

/** A bare source channel resolves in the admitted turn's unique workspace. */
export function slackSourceTargetsMatch(
  target: string,
  context: Parameters<typeof slackContextTargetsMatch>[1],
): boolean {
  if (slackContextTargetsMatch(target, context)) {
    return true;
  }
  const requested = parseSlackTarget(target);
  if (!requested || requested.teamId || requested.kind !== "channel") {
    return false;
  }
  const teams = new Set<string>();
  for (const raw of [context.currentChannelId, context.currentMessagingTarget]) {
    if (!raw) {
      continue;
    }
    const current = parseSlackTarget(raw);
    if (
      !current?.teamId ||
      current.kind !== requested.kind ||
      current.id.toLowerCase() !== requested.id.toLowerCase()
    ) {
      return false;
    }
    teams.add(current.teamId.toLowerCase());
  }
  return teams.size === 1;
}

export {
  looksLikeSlackTargetId,
  normalizeSlackMessagingTarget,
  parseSlackTarget,
  resolveSlackChannelId,
} from "./target-parsing.js";
export type { SlackTarget, SlackTargetKind, SlackTargetParseOptions } from "./target-parsing.js";
