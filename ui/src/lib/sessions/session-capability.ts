import type { SessionCatalogPullRequestSummary } from "../../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { BootRecord } from "../../app/boot-record.ts";
import type { createSessionCapability } from "./index.ts";
import type { createSessionGitHubPublication } from "./session-github-publication.ts";
import type { SessionListScope, SessionListSnapshot, SessionState } from "./session-types.ts";

export type * from "./session-types.ts";

export function createSessionState(
  bootRecord?: Pick<BootRecord, "groups" | "sectionOrder"> | null,
): SessionState {
  return {
    result: null,
    agentId: null,
    modelOverrides: {},
    loading: false,
    error: null,
    deletedSessions: [],
    groups: bootRecord?.groups.map((group) => group.name) ?? [],
    groupSettings: bootRecord?.groups ?? [],
    sectionOrder: bootRecord?.sectionOrder ?? [],
  };
}

/** Local bindings need explicit inputs; operations inherit their owners' signatures. */
export type SessionCapabilityContract = {
  readonly presentation: Pick<SessionState, "result" | "agentId" | "resultCached"> & {
    profileId?: string | null;
  };
  readonly githubPublication: Pick<ReturnType<typeof createSessionGitHubPublication>, "attach">;
  readonly cachedRoutingDefaults?: {
    readonly mainKey: string;
    readonly scope: "per-sender" | "global";
  };
  inheritRow: (
    row: GatewaySessionRow,
    previous: GatewaySessionRow | undefined,
    donor?: GatewaySessionRow,
  ) => GatewaySessionRow;
  invalidate: () => void;
  subscribeList: (
    scope: SessionListScope,
    listener: (snapshot: SessionListSnapshot) => void,
  ) => () => void;
  setPullRequestSummary: (
    key: string,
    summary: SessionCatalogPullRequestSummary | undefined,
    epoch?: object,
  ) => void;
  subscribeCreated: (listener: (key: string) => void) => () => void;
  subscribe: (listener: (state: SessionState) => void) => () => void;
};

export type SessionCapability = Omit<
  ReturnType<typeof createSessionCapability>,
  keyof SessionCapabilityContract
> &
  SessionCapabilityContract;
