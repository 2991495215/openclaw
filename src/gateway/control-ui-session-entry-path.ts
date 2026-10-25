import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { SESSION_UUID_SUFFIX_RE } from "@openclaw/session-url-contract";
import { parseControlUiSessionPath } from "@openclaw/session-url-contract/parse";

export function controlUiSessionEntryPath(basePath: string): string {
  return `${basePath}/__openclaw__/session-entry`;
}

/**
 * The Control UI pins a short session route with the row key it already owns so the
 * loader need not rediscover it from `sessions.list`. The hint never selects or
 * authorizes a session: the pathname stays authoritative, and a hint that does not
 * describe that pathname is rejected outright.
 */
export const CONTROL_UI_SESSION_NAVIGATION_KEY_PARAM = "__openclawSessionKey";
const SESSION_NAVIGATION_KEY_MAX_LENGTH = 512;

type SessionNavigationHint = { agentId: string; rest: string };

function parseSessionNavigationHint(value: string): SessionNavigationHint | null {
  if (value.length === 0 || value.length > SESSION_NAVIGATION_KEY_MAX_LENGTH) {
    return null;
  }
  if (containsAsciiControlCharacter(value) || /\s/u.test(value)) {
    return null;
  }
  const [head, agentId, ...rest] = value.split(":");
  if (head !== "agent" || !agentId || rest.length === 0 || rest.some((part) => !part)) {
    return null;
  }
  return { agentId: agentId.toLowerCase(), rest: rest.join(":") };
}

function sessionNavigationHintMatchesTarget(
  hint: SessionNavigationHint,
  target: NonNullable<ReturnType<typeof parseControlUiSessionPath>>,
): boolean {
  if (hint.agentId !== target.agentId.toLowerCase()) {
    return false;
  }
  if (target.kind === "literal") {
    return `agent:${hint.agentId}:${hint.rest}` === target.sessionKey.toLowerCase();
  }
  if (target.kind === "short") {
    // The URL builder derives the short ref from the trailing UUID of the key, not
    // from its last segment, so prefixed keys (`tui-<uuid>`, `session-<uuid>`) must
    // compare through that same suffix or their routes could never reload.
    const hintedId = hint.rest
      .match(SESSION_UUID_SUFFIX_RE)?.[1]
      ?.toLowerCase()
      .replaceAll("-", "");
    return hintedId ? hintedId.startsWith(target.shortId.toLowerCase()) : false;
  }
  return false;
}

/** Return paths are local chat documents, never URLs, API paths, or credential carriers. */
export function parseControlUiSessionReturnPath(value: string, basePath: string) {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    containsAsciiControlCharacter(value) ||
    /[\\ #]/u.test(value)
  ) {
    return null;
  }
  const url = URL.parse(value, "http://localhost");
  if (
    !url ||
    `${url.pathname}${url.search}` !== value ||
    [...url.searchParams.keys()].some(
      (key) =>
        key !== "dashboard" &&
        key !== "draft" &&
        key !== "openclaw_mount_recovery" &&
        key !== "__openclawSessionFacePreference" &&
        key !== CONTROL_UI_SESSION_NAVIGATION_KEY_PARAM,
    ) ||
    // The UI emits this hint until the session loader resolves its preferred face.
    // Reloading that address must keep the same pathname-based auth and target.
    url.searchParams.getAll("__openclawSessionFacePreference").length > 1 ||
    (url.searchParams.has("__openclawSessionFacePreference") &&
      url.searchParams.get("__openclawSessionFacePreference") !== "1") ||
    url.searchParams.getAll("openclaw_mount_recovery").length > 1 ||
    (url.searchParams.has("openclaw_mount_recovery") &&
      !/^[0-9]+$/u.test(url.searchParams.get("openclaw_mount_recovery") ?? "")) ||
    url.searchParams.getAll("draft").length > 1 ||
    url.searchParams.getAll("dashboard").length > 1 ||
    (url.searchParams.has("dashboard") && url.searchParams.get("dashboard") !== "expanded") ||
    url.searchParams.getAll(CONTROL_UI_SESSION_NAVIGATION_KEY_PARAM).length > 1
  ) {
    return null;
  }
  const target = parseControlUiSessionPath(url.pathname, basePath);
  if (target?.namespace !== "chat") {
    return null;
  }
  const hint = url.searchParams.get(CONTROL_UI_SESSION_NAVIGATION_KEY_PARAM);
  if (hint !== null) {
    const parsedHint = parseSessionNavigationHint(hint);
    if (!parsedHint || !sessionNavigationHintMatchesTarget(parsedHint, target)) {
      return null;
    }
  }
  return target;
}

export function buildControlUiSessionEntryUrl(path: string, basePath: string): string {
  return `${controlUiSessionEntryPath(basePath)}?${new URLSearchParams({ path })}`;
}
