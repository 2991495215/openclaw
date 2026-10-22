import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import type { ApplicationContext } from "../../app/context.ts";
import {
  SESSIONS_PAGE_DEFAULT_LIMIT,
  type SessionArchivedFilter,
  type SessionListOptions,
} from "../../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

type SessionsPageListFilters = {
  activeMinutes?: number;
  limit?: number;
  includeGlobal: boolean;
  includeUnknown: boolean;
  statusFilter: SessionArchivedFilter;
  deepLinkSessionKey?: string | null;
  search?: string;
};

type SessionsPageListState = {
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  statusFilter: SessionArchivedFilter;
  searchQuery: string;
};

export function sessionListOptions(
  context: Pick<ApplicationContext, "agentSelection">,
  state: SessionsPageListState,
  deepLinkSessionKey: string | null,
  search = state.searchQuery,
): SessionListOptions {
  return buildSessionsListQuery(context, {
    activeMinutes: parseStrictPositiveInteger(state.activeMinutes),
    // The Limit box is an explicit page size, so an unparseable entry falls
    // back to the page default rather than to the shared roster page size.
    limit: parseStrictPositiveInteger(state.limit) ?? SESSIONS_PAGE_DEFAULT_LIMIT,
    includeGlobal: state.includeGlobal,
    includeUnknown: state.includeUnknown,
    statusFilter: state.statusFilter,
    deepLinkSessionKey,
    search,
  });
}

export function buildSessionsListQuery(
  context: Pick<ApplicationContext, "agentSelection">,
  filters: SessionsPageListFilters,
): SessionListOptions {
  const deepLinkSessionKey = filters.deepLinkSessionKey?.trim() || null;
  const scopeAgentId =
    parseAgentSessionKey(deepLinkSessionKey)?.agentId ??
    context.agentSelection.state.scopeId?.trim();
  const activeMinutes =
    !deepLinkSessionKey && filters.statusFilter === "active" ? filters.activeMinutes : undefined;
  return {
    source: "sessions-page",
    excludeDock: !deepLinkSessionKey,
    rowMode: "compact",
    limit: deepLinkSessionKey ? SESSIONS_PAGE_DEFAULT_LIMIT : filters.limit,
    ...(activeMinutes ? { activeMinutes } : {}),
    ...(deepLinkSessionKey || filters.search?.trim()
      ? { search: deepLinkSessionKey ?? filters.search!.trim() }
      : {}),
    includeGlobal: deepLinkSessionKey ? true : filters.includeGlobal,
    includeUnknown: deepLinkSessionKey ? true : filters.includeUnknown,
    includeDerivedTitles: false,
    includeLastMessage: false,
    archivedFilter: filters.statusFilter,
    ...(scopeAgentId ? { agentId: scopeAgentId } : {}),
  };
}
