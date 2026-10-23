// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";
import { refetchExpandedSessionCatalogPages } from "./app-sidebar-session-catalog-state.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

const idleSession = { status: "idle", archived: false, canContinue: true, canArchive: true };
function catalog(id: string, hostCount: number): SessionCatalog {
  return {
    id,
    label: id,
    capabilities: { continueSession: true, archive: true },
    hosts: Array.from({ length: hostCount }, (_, hostIndex) => ({
      hostId: `${id}-host-${hostIndex}`,
      label: `Host ${hostIndex}`,
      kind: "node",
      connected: true,
      sessions: [{ ...idleSession, threadId: `${id}-thread-${hostIndex}` }],
    })),
  };
}

let currentLive: SessionCatalogLiveState;
let currentProgressId: string;
beforeEach(() => {
  currentLive = new SessionCatalogLiveState();
  currentProgressId = currentLive.beginRequest(1).progressId;
});
function apply(
  incoming: SessionCatalog,
  catalogs: SessionCatalog[],
  pages = new Map<string, number>(),
) {
  return currentLive.applyHost({
    payload: { progressId: currentProgressId, agentId: "main", catalog: incoming },
    agentId: "main",
    catalogs,
    pageDepths: pages,
  });
}

it.each(["final", "incremental"] as const)(
  "retains rows and cursors for a pending host in %s publications",
  async (publication) => {
    const current = catalog("codex", 2);
    current.hosts[0]!.nextCursor = "next-page";
    const pending = { ...current.hosts[0]!, pending: true, sessions: [], nextCursor: undefined };
    const incoming = { ...current, hosts: [pending] };
    const catalogs =
      publication === "final"
        ? currentLive.mergeFinal([incoming], [current])
        : apply(incoming, [current])!.catalogs;
    expect(catalogs[0]?.hosts[0]).toMatchObject({
      pending: true,
      sessions: current.hosts[0]!.sessions,
      nextCursor: "next-page",
    });
    // A final response still removes genuinely absent hosts.
    expect(catalogs[0]?.hosts).toHaveLength(publication === "final" ? 1 : 2);
    const request = vi.fn();
    expect(
      await refetchExpandedSessionCatalogPages({
        catalogs,
        previousCatalogs: [current],
        client: { request } as unknown as GatewayBrowserClient,
        agentId: "main",
        pageDepths: new Map([[sessionCatalogHostKey("codex", pending.hostId), 1]]),
        isCurrent: () => true,
        canRequestPage: () => true,
      }),
    ).toEqual(catalogs);
    expect(request).not.toHaveBeenCalled();
  },
);

it("does not replace a settled progressive host with its pending final response", () => {
  const current = catalog("codex", 1);
  const pending = { ...current.hosts[0]!, pending: true, sessions: [] };
  const published = apply(current, [{ ...current, hosts: [pending] }])!;
  expect(currentLive.mergeFinal([{ ...current, hosts: [pending] }], published.catalogs)).toEqual([
    current,
  ]);
});

it("clears unavailable native readiness without losing another host or expanded rows", () => {
  const current = catalog("codex", 2);
  current.capabilities.startTerminal = true;
  current.hosts.forEach((host) => {
    host.canStartTerminal = true;
  });
  const changed = {
    ...current.hosts[0]!,
    canStartTerminal: false,
    sessions: [],
    error: { code: "offline", message: "Offline" },
  };
  const result = apply(
    { ...current, hosts: [changed] },
    [current],
    new Map([[sessionCatalogHostKey("codex", changed.hostId), 1]]),
  );
  expect(result?.catalogs[0]?.hosts.map((host) => host.canStartTerminal)).toEqual([false, true]);
  expect(result?.catalogs[0]?.hosts[1]).toEqual(current.hosts[1]);
  expect(result?.catalogs[0]?.hosts[0]?.sessions).toEqual(current.hosts[0]?.sessions);
});
it("compares a host event only with the catalog and host it can replace", () => {
  const changed = catalog("changed", 1);
  const unrelated = catalog("unrelated", 100);
  Object.defineProperty(unrelated, "toJSON", {
    value: () => {
      throw new Error("unrelated catalog serialized");
    },
  });

  expect(apply(changed, [changed, unrelated])).toBeNull();
});

it.each(["pending", "error", "fresh"] as const)(
  "does not retain prior source-authorized rows in %s final or incremental snapshots",
  async (state) => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const current = { ...catalog("source-authorized", 1), requiresFreshList: true as const };
    current.hosts[0]!.nextCursor = "old-cursor";
    const { nextCursor: _cursor, ...host } = current.hosts[0]!;
    const fresh = {
      ...current,
      hosts: [
        {
          ...host,
          sessions: [],
          ...(state === "pending" ? { pending: true } : {}),
          ...(state === "error"
            ? { error: { code: "UNAVAILABLE", message: "Source offline" } }
            : {}),
        },
      ],
    };
    const depths = new Map([[sessionCatalogHostKey(current.id, host.hostId), 1]]);
    const final = live.mergeFinal([fresh], [current]);
    const incremental = live.applyHost({
      payload: { progressId, agentId: "main", catalog: fresh },
      agentId: "main",
      catalogs: [current],
      pageDepths: depths,
    });
    expect(incremental?.catalogs[0]?.hosts[0]?.sessions).toEqual([]);
    const expanded = await refetchExpandedSessionCatalogPages({
      catalogs: final,
      previousCatalogs: [current],
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      agentId: "main",
      pageDepths: depths,
      isCurrent: () => true,
      canRequestPage: () => true,
    });
    expect(expanded[0]?.hosts[0]?.sessions).toEqual([]);
    expect(expanded[0]?.hosts[0]?.nextCursor).toBeUndefined();
  },
);

it("rejects earlier source-authorized progress after a new refresh starts", () => {
  const live = new SessionCatalogLiveState();
  const previous = live.beginRequest(1);
  const current = { ...catalog("source-authorized", 1), requiresFreshList: true as const };
  const next = live.beginRequest(1);
  const withdrawn = {
    ...current,
    hosts: current.hosts.map((host) => Object.assign({}, host, { sessions: [] })),
  };
  expect(
    live.applyHost({
      payload: { progressId: previous.progressId, agentId: "main", catalog: current },
      agentId: "main",
      catalogs: [withdrawn],
      pageDepths: new Map(),
    }),
  ).toBeNull();
  const fresh = live.applyHost({
    payload: { progressId: next.progressId, agentId: "main", catalog: current },
    agentId: "main",
    catalogs: [withdrawn],
    pageDepths: new Map(),
  });
  expect(fresh?.catalogs).toEqual([current]);
  expect(
    live.mergeFinal(
      [
        {
          ...withdrawn,
          hosts: withdrawn.hosts.map((host) => Object.assign({}, host, { pending: true })),
        },
      ],
      fresh!.catalogs,
    ),
  ).toEqual([current]);
});

describe("root window settlement", () => {
  it("leaves a rejected host intent untouched during a sibling provider failure", () => {
    const live = new SessionCatalogLiveState();
    const fresh = { ...catalog("source", 2), requiresFreshList: true as const };
    fresh.hosts[1]!.error = { code: "UNAVAILABLE", message: "Sibling unavailable" };
    const rejected = fresh.hosts[0]!.hostId;
    const key = sessionCatalogHostKey(fresh.id, rejected);
    const intent = { depth: 2, request: { depth: 3, status: "available" as const } };
    live.windows.set(key, intent);

    live.settleRootWindows([fresh], undefined, (_catalogId, hostId) => hostId !== rejected);

    expect(live.windows.get(key)).toEqual(intent);
    expect(live.requestedDepth(fresh.id, fresh.hosts[1]!.hostId)).toBe(0);
    expect(live.canRetry(fresh)).toBe(true);
  });

  it.each([false, true])("preserves any rejection for aliased keys, reverse=%s", (reverse) => {
    const live = new SessionCatalogLiveState();
    const rejected = catalog("source", 1);
    rejected.hosts[0]!.hostId = "group\u0000leaf";
    const accepted = catalog("source\u0000group", 1);
    accepted.hosts[0]!.hostId = "leaf";
    const key = sessionCatalogHostKey(rejected.id, rejected.hosts[0]!.hostId);
    const intent = { depth: 2, request: { depth: 3, status: "available" as const } };
    live.windows.set(key, intent);

    live.settleRootWindows(
      reverse ? [accepted, rejected] : [rejected, accepted],
      undefined,
      (catalogId) => catalogId !== rejected.id,
    );

    expect(live.requestedDepth(accepted.id, "leaf")).toBe(3);
    expect(live.windows.get(key)).toEqual(intent);
  });

  it.each([false, true])(
    "finalizes every aliased host in catalog order, failureLast=%s",
    (failureLast) => {
      const live = new SessionCatalogLiveState();
      const failed: SessionCatalog = { ...catalog("source", 1), requiresFreshList: true as const };
      failed.hosts[0]!.hostId = "group\u0000leaf";
      failed.error = { code: "UNAVAILABLE", message: "Provider unavailable" };
      const completed = { ...catalog("source\u0000group", 1), requiresFreshList: true as const };
      completed.hosts[0]!.hostId = "leaf";
      const key = sessionCatalogHostKey(failed.id, failed.hosts[0]!.hostId);
      live.windows.set(key, { depth: 2, request: { depth: 5, status: "retry" } });

      live.settleRootWindows(failureLast ? [completed, failed] : [failed, completed]);

      expect(live.windows.get(key)).toEqual(
        failureLast ? { depth: 2, request: { depth: 2, status: "retry" } } : { depth: 2 },
      );
    },
  );
});
