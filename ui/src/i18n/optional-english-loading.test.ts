/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

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
  const { formatSessionArchiveReason } = await import("../lib/sessions/session-archive-reason.ts");

  expect(formatSessionArchiveReason("age-retention")).toBe(
    "Automatically archived by age retention",
  );
  expect(manager.t("sessionsView.stopCloudWorkerConfirm", { session: "Project" })).toBe(
    'Stop the cloud worker for "Project"?',
  );
  expect(manager.t("sessionsView.newGroupTitle")).toBe("New group");
  expect(manager.t("sessionsView.communication.title")).toBe("sessionsView.communication.title");

  await manager.setLocale("de");
  await import("../components/solid/sidebar-owner-filter.tsx");

  expect(manager.t("sessionsView.communication.title")).toBe("Cross-session messaging");
  expect(manager.t("sessionsView.stopCloudWorker")).toBe("Cloud-Worker stoppen");
  expect(en.sessionsView).toBe(sessions);
  expect(en.sessionsView.colors).toBe(colors);
});
