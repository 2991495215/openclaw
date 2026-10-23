/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("keeps a cold roster metadata failure readable before its view catalog loads", async () => {
  const { en, manager } = await loadI18n();
  const agentsHome = en.agentsHome;
  const { createRosterFixture, rosterResult } =
    await import("../lib/agents/roster-activity-store.test-support.ts");
  const { createGatewayRequestMock, createTestGatewayClient } =
    await import("../test-helpers/gateway-client.ts");
  const request = createGatewayRequestMock(async (method) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.groups.list") {
      return { groups: [], sectionOrder: [] };
    }
    if (method === "sessions.list") {
      return rosterResult();
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const { context, store, sessions } = createRosterFixture(createTestGatewayClient(request));
  context.agents.ensureList = async () => null;
  expect(manager.t("agentsHome.pinnedAgents")).toBe("agentsHome.pinnedAgents");
  const stop = store.subscribe(() => {});
  try {
    await store.refresh();
    expect(store.snapshot.error).toBe("Could not load agents. Try again.");
    const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
    const { registerAgentsHomeEnglish } = await import("./locales/en-agents-home.ts");
    registerEnglishCatalog(registerAgentsHomeEnglish);
    expect(en.agentsHome).toBe(agentsHome);
    await store.refresh();
    expect(store.snapshot.error).toBe("Could not load agents. Try again.");
  } finally {
    stop();
    sessions.dispose();
  }
});

it("loads Details copy through its lazy view while preserving the active locale and namespace", async () => {
  const { en, manager } = await loadI18n({
    common: { health: "Gesundheit" },
    chat: { sessionDetails: { context: "Kontext" } },
  });
  const details = en.chat.sessionDetails;
  const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
  const { registerChatSessionEnglish } = await import("./locales/en-chat-session.ts");
  registerEnglishCatalog(registerChatSessionEnglish);
  await manager.setLocale("de");
  expect(manager.t("chat.sessionDetails.title")).toBe("Details");
  expect(manager.t("chat.sessionDetails.progressHidden")).toBe(
    "Task progress hidden in this browser.",
  );
  expect(manager.t("chat.sessionDetails.environment")).toBe("chat.sessionDetails.environment");

  await import("../pages/chat/components/chat-context-breakdown.tsx");

  expect(manager.t("chat.sessionDetails.environment")).toBe("Environment");
  expect(manager.t("chat.sessionDetails.context")).toBe("Kontext");
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(manager.getLocale()).toBe("de");
  expect(en.chat.sessionDetails).toBe(details);
});

it("loads optional English copy at each view boundary while keeping shared labels eager", async () => {
  const { en, manager } = await loadI18n();
  const about = en.aboutPage;
  const dashboards = en.dashboardsPage;
  expect(manager.t("aboutPage.artifactDetails")).toBe("Control UI build details");
  expect(manager.t("aboutPage.copiedCommit")).toBe("Commit hash copied");
  await manager.setLocale("de");
  for (const { key, load, catalog } of [
    {
      key: "aboutPage.tagline",
      load: () => import("../pages/about/view.tsx"),
      catalog: async () => (await import("./locales/en-about.ts")).registerAboutEnglish.catalog,
    },
    {
      key: "dashboardsPage.emptyDescription",
      load: () => import("../pages/dashboards/view.tsx"),
      catalog: async () =>
        (await import("./locales/en-dashboards.ts")).registerDashboardsEnglish.catalog,
    },
  ]) {
    expect(manager.t(key)).toBe(key);
    await load();
    for (const [catalogKey, value] of flattenTranslations(await catalog())) {
      expect(manager.t(catalogKey)).toBe(value);
    }
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(en.aboutPage).toBe(about);
    expect(en.dashboardsPage).toBe(dashboards);
  }
});

it("loads session-owner copy before organization menus while retaining the namespace", async () => {
  const { en, manager } = await loadI18n({
    sessionsView: { stopCloudWorker: "Cloud-Worker stoppen" },
  });
  const sessions = en.sessionsView;
  const colors = sessions.colors;
  const worktrees = en.worktrees;
  const { formatSessionArchiveReason } = await import("../lib/sessions/session-archive-reason.ts");
  const { formatPreservedWorktreesNotice } =
    await import("../lib/sessions/worktree-preservation.ts");

  expect(formatSessionArchiveReason("age-retention")).toBe(
    "Automatically archived by age retention",
  );
  expect(manager.t("sessionsView.stopCloudWorkerConfirm", { session: "Project" })).toBe(
    'Stop the cloud worker for "Project"?',
  );
  expect(manager.t("sessionsView.newGroupTitle")).toBe("New group");
  expect(
    formatPreservedWorktreesNotice([
      { id: "wt-busy", branch: "openclaw/busy", path: "/worktrees/busy", reason: "busy" },
    ]),
  ).toBe("Managed Worktrees:\nopenclaw/busy — live run or cleanup active");
  expect(manager.t("sessionsView.communication.title")).toBe("sessionsView.communication.title");
  expect(manager.t("worktrees.subtitle")).toBe("worktrees.subtitle");

  await manager.setLocale("de");
  await import("../components/solid/sidebar-owner-filter.tsx");

  expect(manager.t("sessionsView.communication.title")).toBe("Cross-session messaging");
  expect(manager.t("sessionsView.stopCloudWorker")).toBe("Cloud-Worker stoppen");
  expect(en.sessionsView).toBe(sessions);
  expect(en.sessionsView.colors).toBe(colors);
  expect(en.worktrees).toBe(worktrees);
});

it("loads panel copy at a lazy consumer and preserves nested namespaces on repeated registration", async () => {
  const { en, manager } = await loadI18n({
    common: { health: "Gesundheit" },
    chat: { workspaceFiles: { desktop: { project: "Projekt" } } },
  });
  const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
  const { registerChatSessionEnglish } = await import("./locales/en-chat-session.ts");
  registerEnglishCatalog(registerChatSessionEnglish);
  await manager.setLocale("de");
  const namespaces = {
    chat: en.chat,
    automation: en.chat.sessionAutomation,
    subagents: en.chat.subagentsPanel,
    header: en.chat.sessionHeader,
    terminal: en.chat.sessionHeader.continueInTerminal,
    youtube: en.chat.youtube,
    rail: en.chat.rail,
    diff: en.chat.sessionDiff,
    discussion: en.chat.sessionDiscussion,
    files: en.chat.workspaceFiles,
    desktop: en.chat.workspaceFiles.desktop,
  };
  expect(manager.t("chat.subagentsPanel.title")).toBe("Subagents");
  expect(manager.t("chat.workspaceFiles.desktop.sessionFiles")).toBe("Session files");
  expect(manager.t("chat.sessionAutomation.occurrence6")).toBe("Last");
  expect(manager.t("chat.youtube.video")).toBe("YouTube video");
  const coldCopy = [
    ["chat.subagentsPanel.nativeStatus.interrupted", "Interrupted"],
    ["chat.subagentsPanel.desktopFilter.active", "Active"],
    ["chat.sessionHeader.continueInTerminal.title", "Continue in terminal"],
    ["chat.youtube.player", "YouTube player: {title}"],
    ["chat.rail.health.waiting-on-user", "Waiting on you"],
    ["chat.sessionDiff.modeUnified", "Unified"],
    ["chat.sessionDiscussion.loading", "Loading discussion…"],
    ["chat.workspaceFiles.mobile.searchFolder", "Search in {folder}"],
  ];
  for (const [key] of coldCopy) {
    expect(manager.t(key)).toBe(key);
  }

  await import("../pages/chat/components/continue-in-terminal-dialog.tsx");
  for (const [key, value] of coldCopy) {
    expect(manager.t(key)).toBe(value);
  }
  const nativeStatus = en.chat.subagentsPanel.nativeStatus;
  const desktopFilter = en.chat.subagentsPanel.desktopFilter;
  registerChatSessionEnglish();
  await import("../pages/chat/components/youtube-video-card.tsx");
  registerChatSessionEnglish();
  const currentNamespaces = {
    chat: en.chat,
    automation: en.chat.sessionAutomation,
    subagents: en.chat.subagentsPanel,
    header: en.chat.sessionHeader,
    terminal: en.chat.sessionHeader.continueInTerminal,
    youtube: en.chat.youtube,
    rail: en.chat.rail,
    diff: en.chat.sessionDiff,
    discussion: en.chat.sessionDiscussion,
    files: en.chat.workspaceFiles,
    desktop: en.chat.workspaceFiles.desktop,
  };
  for (const key of Object.keys(namespaces) as Array<keyof typeof namespaces>) {
    expect(currentNamespaces[key]).toBe(namespaces[key]);
  }
  expect(en.chat.subagentsPanel.nativeStatus).toBe(nativeStatus);
  expect(en.chat.subagentsPanel.desktopFilter).toBe(desktopFilter);
  for (const [key, value] of coldCopy) {
    expect(manager.t(key)).toBe(value);
  }
  expect(manager.t("chat.workspaceFiles.desktop.project")).toBe("Projekt");
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(manager.getLocale()).toBe("de");
});
