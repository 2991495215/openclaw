import type { SessionsUsageResult } from "../../../../src/shared/usage-types.js";
import type { GatewayRetrySnapshot } from "../gateway-retry.ts";
import type { SessionRequestClient } from "./session-capability.ts";

export type SessionUsageTarget = { key: string; agentId?: string };

export type SessionUsageQuery = {
  startDate: string;
  endDate: string;
  scope: "instance" | "family";
  timeZone: "local" | "utc";
  agentId?: string;
  creatorKey?: string;
  query?: string;
  selectedDays?: string[];
  selectedHours?: number[];
  selectedSessions?: string[];
  recentKeys?: string[];
  offset?: number;
  sort?: "recent" | "tokens" | "cost" | "messages" | "errors";
  sortDirection?: "asc" | "desc";
};

function formatUtcOffset(timezoneOffsetMinutes: number): string {
  const offsetFromUtcMinutes = -timezoneOffsetMinutes;
  const sign = offsetFromUtcMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetFromUtcMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${minutes.toString().padStart(2, "0")}`;
}

function buildSessionUsageDateParams(timeZone: "local" | "utc") {
  return timeZone === "utc"
    ? { mode: "utc" }
    : {
        mode: "specific",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        utcOffset: formatUtcOffset(new Date().getTimezoneOffset()),
      };
}

export function requestSessionUsage(
  client: SessionRequestClient,
  query: SessionUsageQuery,
  options?: {
    key?: string;
    projection?: "overview";
    limit?: number;
    includeContextWeight?: boolean;
    signal?: AbortSignal;
  },
): Promise<SessionsUsageResult> {
  const key = options?.key;
  const params = {
    startDate: query.startDate,
    endDate: query.endDate,
    ...(query.agentId ? { agentId: query.agentId } : key ? {} : { agentScope: "all" }),
    ...buildSessionUsageDateParams(query.timeZone),
    ...(query.creatorKey ? { creatorKey: query.creatorKey } : {}),
    groupBy: query.scope,
    ...(key
      ? { key, limit: 1 }
      : {
          limit: options?.limit ?? (options?.projection === "overview" ? 50 : 1000),
          ...(options?.projection ? { projection: options.projection } : {}),
          ...(query.query ? { query: query.query } : {}),
          ...(query.selectedDays?.length ? { selectedDays: query.selectedDays } : {}),
          ...(query.selectedHours?.length ? { selectedHours: query.selectedHours } : {}),
          ...(query.selectedSessions?.length ? { selectedSessions: query.selectedSessions } : {}),
          ...(query.offset ? { offset: query.offset } : {}),
          ...(query.recentKeys ? { recentKeys: query.recentKeys } : {}),
          ...(query.sort ? { sort: query.sort } : {}),
          ...(query.sortDirection ? { sortDirection: query.sortDirection } : {}),
        }),
    includeContextWeight: options?.includeContextWeight === true,
  };
  return options?.signal
    ? client.request<SessionsUsageResult>("sessions.usage", params, { signal: options.signal })
    : client.request<SessionsUsageResult>("sessions.usage", params);
}

const usageRetries = new WeakMap<
  SessionRequestClient,
  { scope: string; entries: Map<string, GatewayRetrySnapshot> }
>();

/** Only numeric retry facts survive a Context mount; timers and callbacks stay local. */
export function sessionUsageRetryState(
  client: SessionRequestClient | null,
  scope: string,
  key: string,
) {
  let cache = client ? usageRetries.get(client) : undefined;
  if (cache?.scope !== scope) {
    cache = { scope, entries: new Map() };
    if (client) {
      usageRetries.set(client, cache);
    }
  }
  const entries = cache.entries;
  // No expiry timer is needed while hidden; the next acquisition drops old deadlines.
  for (const [id, retry] of entries) {
    if (id !== key && retry.deadline <= Date.now()) {
      entries.delete(id);
    }
  }
  return {
    read: () => entries.get(key),
    remember(retry: GatewayRetrySnapshot | undefined) {
      if (!retry) {
        return;
      }
      const previous = entries.get(key);
      entries.set(key, {
        deadline: Math.max(previous?.deadline ?? 0, retry.deadline),
        nextDelayMs: Math.max(previous?.nextDelayMs ?? 0, retry.nextDelayMs),
      });
    },
    clear(receipt: GatewayRetrySnapshot | undefined) {
      if (receipt && entries.get(key) === receipt) {
        entries.delete(key);
      }
    },
  };
}
