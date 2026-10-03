/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { loadMoreSessionCatalog } from "./session-data-controller-catalog.ts";
import "./app-sidebar.ts";

function sourceCatalogPage(rows: Parameters<typeof catalogPage>[0], cursor?: string) {
  const page = catalogPage(rows, cursor);
  for (const catalog of page.catalogs) {
    catalog.requiresFreshList = true;
  }
  return page;
}

async function mountTab(
  request = createGatewayRequestMock().mockResolvedValue(
    catalogPage([{ threadId: "stable", name: "Stable catalog" }]),
  ),
  events: string[] | undefined = ["sessions.catalog.changed"],
) {
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({
    hello: {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["sessions.catalog.list"], events },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const { sidebar } = await mountSidebar(
    gateway.gateway,
    createSessions("main", ["agent:main:main"]),
  );
  sidebar.connected = true;
  await sidebar.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(1);
  return { sidebar, gateway, request };
}

describe("AppSidebar catalog event refresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["pending", "failed", "success"] as const)(
    "withdraws source-authorized rows before a %s refresh settles",
    async (outcome) => {
      const shared = sourceCatalogPage([{ threadId: "private", name: "Source-authorized row" }]);
      const pending = deferred<typeof shared>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(shared)
        .mockReturnValueOnce(pending.promise);
      const { sidebar } = await mountTab(request);
      expect(sidebar.textContent).toContain("Source-authorized row");
      const refresh = sidebar.sessionData.refreshSessionCatalogs();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect.soft(sidebar.textContent).not.toContain("Source-authorized row");
      if (outcome === "failed") {
        pending.reject(new Error("Source unavailable"));
      } else {
        const result = outcome === "success" ? shared : sourceCatalogPage([]);
        if (outcome === "pending") {
          for (const catalog of result.catalogs) {
            for (const host of catalog.hosts) {
              host.pending = true;
            }
          }
        }
        pending.resolve(result);
      }
      await refresh;
      await sidebar.updateComplete;
      expect(sidebar.textContent?.includes("Source-authorized row")).toBe(outcome === "success");
    },
  );

  it.each(["success", "failed", "revoked"] as const)(
    "reauthorizes the whole source window during %s load-more",
    async (outcome) => {
      const page = sourceCatalogPage;
      const warm = page([{ threadId: "old", name: "Previously authorized head" }], "old-cursor");
      const refreshed = deferred<typeof warm>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(warm)
        .mockReturnValueOnce(refreshed.promise)
        .mockResolvedValue(page([{ threadId: "older", name: "Fresh older row" }]));
      const { sidebar } = await mountTab(request);
      const more = sidebar.sessionData.loadMoreSessionCatalog("codex");
      await sidebar.updateComplete;
      expect(sidebar.textContent).not.toContain("Previously authorized head");
      expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
      });
      if (outcome === "failed") {
        refreshed.reject(new Error("Source unavailable"));
      } else {
        refreshed.resolve(
          outcome === "revoked"
            ? page([])
            : page([{ threadId: "fresh", name: "Fresh authorized head" }], "fresh-cursor"),
        );
      }
      await more;
      await sidebar.updateComplete;
      expect(sidebar.textContent).not.toContain("Previously authorized head");
      if (outcome === "success") {
        expect(sidebar.textContent).toContain("Fresh authorized head");
        expect(sidebar.textContent).toContain("Fresh older row");
        expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
          agentId: "main",
          catalogId: "codex",
          hostIds: ["gateway:local"],
          cursors: { "gateway:local": "fresh-cursor" },
        });
      } else {
        expect(sidebar.textContent).not.toContain("Fresh older row");
        expect(request).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("advances source-authorized discovery across multiple empty pages", async () => {
    const page = sourceCatalogPage;
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(page([{ threadId: "old", name: "Old head" }], "page-2"))
      .mockResolvedValueOnce(page([], "page-2"))
      .mockResolvedValueOnce(page([], "page-3"))
      .mockResolvedValueOnce(page([], "page-2"))
      .mockResolvedValueOnce(page([], "page-3"))
      .mockResolvedValueOnce(page([{ threadId: "visible", name: "Visible later page" }]));
    const { sidebar } = await mountTab(request);
    await loadMoreSessionCatalog(sidebar.sessionData, "codex", undefined, true);
    await loadMoreSessionCatalog(sidebar.sessionData, "codex", undefined, true);
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain("Visible later page");
    expect(request).toHaveBeenCalledTimes(6);
    expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
      agentId: "main",
      catalogId: "codex",
      hostIds: ["gateway:local"],
      cursors: { "gateway:local": "page-3" },
    });
  });

  it.each(["revoked", "failed"] as const)(
    "rejects old host publications during and after %s source load-more",
    async (outcome) => {
      const warm = sourceCatalogPage([{ threadId: "old", name: "Old source publication" }], "next");
      const next = deferred<typeof warm>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(warm)
        .mockReturnValueOnce(next.promise);
      const { sidebar, gateway } = await mountTab(request);
      const progressId = (request.mock.calls[0]![1] as { progressId: string }).progressId;
      const more = sidebar.sessionData.loadMoreSessionCatalog("codex");
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: warm.catalogs[0],
      });
      await sidebar.updateComplete;
      expect.soft(sidebar.textContent).not.toContain("Old source publication");
      if (outcome === "failed") {
        next.reject(new Error("Source unavailable"));
      } else {
        next.resolve(sourceCatalogPage([]));
      }
      await more;
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: warm.catalogs[0],
      });
      await sidebar.updateComplete;
      expect(sidebar.textContent).not.toContain("Old source publication");
    },
  );

  it("does not let an older root result overwrite source load-more withdrawal", async () => {
    const warm = sourceCatalogPage([{ threadId: "old", name: "Old root publication" }], "next");
    const root = deferred<typeof warm>();
    const next = deferred<typeof warm>();
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(warm)
      .mockReturnValueOnce(root.promise)
      .mockReturnValueOnce(next.promise);
    const { sidebar } = await mountTab(request);
    const refresh = sidebar.sessionData.refreshSessionCatalogs();
    const more = sidebar.sessionData.loadMoreSessionCatalog("codex");
    root.resolve(warm);
    await refresh;
    await sidebar.updateComplete;
    expect.soft(sidebar.textContent).not.toContain("Old root publication");
    next.resolve(sourceCatalogPage([]));
    await more;
    await sidebar.updateComplete;
    expect(sidebar.textContent).not.toContain("Old root publication");
  });

  it.each(["head", "deeper"] as const)(
    "keeps both hosts when late sibling progress arrives during the fresh %s request",
    async (phase) => {
      const warm = sourceCatalogPage([{ threadId: "old-a", name: "Old A" }], "old-next");
      const hostA = warm.catalogs[0]!.hosts[0]!;
      const hostB = {
        ...hostA,
        hostId: "node:b",
        label: "Host B",
        pending: true,
        nextCursor: undefined,
        sessions: [],
      };
      warm.catalogs[0]!.hosts.push(hostB);
      const head = sourceCatalogPage([{ threadId: "fresh-a", name: "Fresh A" }], "fresh-next");
      const deep = sourceCatalogPage([{ threadId: "deep-a", name: "Deep A" }]);
      const held = deferred<typeof warm>();
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(warm)
        .mockReturnValueOnce(phase === "head" ? held.promise : Promise.resolve(head))
        .mockReturnValueOnce(phase === "deeper" ? held.promise : Promise.resolve(deep));
      const { sidebar, gateway } = await mountTab(request);
      const progressId = (request.mock.calls[0]![1] as { progressId: string }).progressId;
      const more = loadMoreSessionCatalog(sidebar.sessionData, "codex", ["gateway:local"]);
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.textContent).not.toContain("Old A");
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: {
          ...warm.catalogs[0],
          hosts: [
            {
              ...hostB,
              pending: false,
              sessions: [{ ...hostA.sessions[0]!, threadId: "fresh-b", name: "Fresh B" }],
            },
          ],
        },
      });
      held.resolve(phase === "head" ? head : deep);
      await more;
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Fresh A");
      expect(sidebar.textContent).toContain("Deep A");
      expect(sidebar.textContent).toContain("Fresh B");
      expect(sidebar.textContent).not.toContain("Old A");
      expect(sidebar.sessionData.loadingMoreSessionCatalogIds.size).toBe(0);
      expect(request).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["success", "revoked", "failed", "new-root"] as const)(
    "replays only currently authorized expanded pages after late host progress: %s",
    async (outcome) => {
      const head = sourceCatalogPage([{ threadId: "head", name: "Authorized head" }], "next");
      const oldDeep = sourceCatalogPage([{ threadId: "old-deep", name: "Old deeper row" }]);
      const pending = sourceCatalogPage([]);
      pending.catalogs[0]!.hosts[0]!.pending = true;
      const held = deferred<typeof head>();
      void held.promise.catch(() => undefined);
      const request = createGatewayRequestMock()
        .mockResolvedValueOnce(head)
        .mockResolvedValueOnce(head)
        .mockResolvedValueOnce(oldDeep)
        .mockResolvedValueOnce(pending)
        .mockReturnValueOnce(held.promise)
        .mockResolvedValue(sourceCatalogPage([]));
      const { sidebar, gateway } = await mountTab(request);
      await loadMoreSessionCatalog(sidebar.sessionData, "codex", ["gateway:local"]);
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Old deeper row");
      await sidebar.sessionData.refreshSessionCatalogs();
      const progressId = (request.mock.calls[3]![1] as { progressId: string }).progressId;
      gateway.publishEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: head.catalogs[0],
      });
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.textContent).not.toContain("Old deeper row");
      expect(request).toHaveBeenCalledTimes(5);
      if (outcome === "new-root") {
        await sidebar.sessionData.refreshSessionCatalogs();
      }
      if (outcome === "failed") {
        held.reject(new Error("Source unavailable"));
      } else {
        held.resolve(
          sourceCatalogPage(
            outcome === "revoked" ? [] : [{ threadId: "fresh-deep", name: "Fresh deeper row" }],
          ),
        );
      }
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.textContent).not.toContain("Old deeper row");
      expect(sidebar.textContent?.includes("Fresh deeper row")).toBe(outcome === "success");
      expect(sidebar.textContent?.includes("Authorized head")).toBe(
        outcome === "success" || outcome === "revoked",
      );
      if (outcome === "failed") {
        expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.error?.message).toBe(
          "Source unavailable",
        );
      }
    },
  );

  it("keeps four stable tabs idle for five minutes and refreshes each once per catalog event", async () => {
    const tabs = [];
    for (let index = 0; index < 4; index += 1) {
      tabs.push(await mountTab());
    }
    await vi.advanceTimersByTimeAsync(300_000);
    for (const { request, gateway } of tabs) {
      expect.soft(request).toHaveBeenCalledTimes(1);
      request.mockClear();
      gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    }
    await vi.advanceTimersByTimeAsync(5_000);
    for (const { request, sidebar } of tabs) {
      expect(request).toHaveBeenCalledTimes(1);
      expect(sidebar.textContent).toContain("Stable catalog");
    }
  });

  it("ignores session churn and unrelated agents while coalescing catalog event bursts", async () => {
    const { gateway, request } = await mountTab();
    gateway.publishEvent("sessions.changed", {
      agentId: "research",
      sessionKey: "agent:research:x",
    });
    gateway.publishEvent("sessions.catalog.changed", { agentId: "research" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);
    gateway.publishEvent("sessions.changed", { agentId: "main", sessionKey: "agent:main:x" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps a stable 30-second fallback when catalog changes are not advertised", async () => {
    const events = ["sessions.changed"];
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(catalogPage([]))
      .mockResolvedValue(catalogPage([{ threadId: "discovered", name: "New catalog row" }]));
    const { gateway, sidebar } = await mountTab(request, events);
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    gateway.publishEvent("sessions.changed", { agentId: "main", sessionKey: "agent:main:x" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect.soft(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(sidebar.textContent).toContain("New catalog row");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("paces a trailing event after a slow catalog request without overlapping reads", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const pending = deferred<ReturnType<typeof catalogPage>>();
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(catalogPage([]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(catalogPage([{ threadId: "updated", name: "Updated catalog" }]));
    const { gateway, sidebar } = await mountTab(request);
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(2);
    for (let second = 0; second < 3; second += 1) {
      gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(request).toHaveBeenCalledTimes(2);
    pending.resolve(catalogPage([]));
    await vi.advanceTimersByTimeAsync(8_999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sidebar.textContent).toContain("Updated catalog");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("absorbs an event when an explicit refresh already reads the current catalog", async () => {
    const { gateway, sidebar, request } = await mountTab();
    gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
    await sidebar.sessionData.refreshSessionCatalogs();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("recovers a busy catalog without flashing an error or letting events bypass the retry delay", async () => {
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(catalogPage([{ threadId: "stable", name: "Stable catalog" }]))
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "server busy",
          retryable: true,
          retryAfterMs: 5_000,
        }),
      )
      .mockResolvedValue(catalogPage([{ threadId: "updated", name: "Updated catalog" }]));
    const { gateway, sidebar } = await mountTab(request);
    await sidebar.sessionData.refreshSessionCatalogs();
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain("Stable catalog");
    expect(sidebar.sessionData.sessionCatalogRefreshStatus.error).toBeNull();
    for (let second = 0; second < 4; second += 1) {
      gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request).toHaveBeenCalledTimes(2);
    }
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await sidebar.updateComplete;
    expect(request).toHaveBeenCalledTimes(3);
    expect(sidebar.textContent).toContain("Updated catalog");
    expect(sidebar.sessionData.sessionCatalogRefreshStatus.error).toBeNull();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("bounds busy retries and reports a persistent failure while preserving the catalog", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(catalogPage([{ threadId: "stable", name: "Stable catalog" }]))
      .mockRejectedValue(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "server busy",
          retryable: true,
          retryAfterMs: 100,
        }),
      );
    try {
      const { sidebar } = await mountTab(request);
      await sidebar.sessionData.refreshSessionCatalogs();
      for (const delay of [1_000, 2_000, 4_000]) {
        expect(sidebar.sessionData.sessionCatalogRefreshStatus.error).toBeNull();
        expect(warning).not.toHaveBeenCalled();
        const requests = request.mock.calls.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(request).toHaveBeenCalledTimes(requests);
        await vi.advanceTimersByTimeAsync(1);
        expect(request).toHaveBeenCalledTimes(requests + 1);
      }
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Stable catalog");
      expect(sidebar.sessionData.sessionCatalogRefreshStatus).toMatchObject({
        error: expect.any(String),
        stale: true,
      });
      expect(warning).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(request).toHaveBeenCalledTimes(5);
    } finally {
      warning.mockRestore();
    }
  });

  it.each(["hide", "remove"])(
    "retires a pending catalog retry when the sidebar must %s",
    async (action) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      let visibility: DocumentVisibilityState = "visible";
      const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      const request = createGatewayRequestMock()
        .mockRejectedValueOnce(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "server busy",
            retryable: true,
            retryAfterMs: 5_000,
          }),
        )
        .mockResolvedValue(catalogPage([{ threadId: "recovered", name: "Recovered catalog" }]));
      try {
        const { sidebar } = await mountTab(request);
        if (action === "remove") {
          sidebar.remove();
        } else {
          visibility = "hidden";
          document.dispatchEvent(new Event("visibilitychange"));
        }
        await vi.advanceTimersByTimeAsync(2_000);
        expect(request).toHaveBeenCalledOnce();
        if (action === "hide") {
          visibility = "visible";
          document.dispatchEvent(new Event("visibilitychange"));
          await vi.advanceTimersByTimeAsync(4_999);
          expect(request).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(1);
          expect(request).toHaveBeenCalledTimes(2);
          expect(sidebar.textContent).toContain("Recovered catalog");
        } else {
          await vi.advanceTimersByTimeAsync(300_000);
          expect(request).toHaveBeenCalledOnce();
        }
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("rechecks visibility after queued background admission", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    try {
      const { gateway, request, sidebar } = await mountTab();
      const context = sidebar.sessionData.context;
      context?.connectionBootstrap.setForegroundRoute(undefined);
      gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
      await vi.advanceTimersByTimeAsync(5_000);
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      context?.connectionBootstrap.setForegroundRoute(null);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(request).toHaveBeenCalledTimes(1);
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
