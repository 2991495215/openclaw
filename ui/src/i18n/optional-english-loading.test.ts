/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

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

it("loads session interaction settings copy before search reads it", async () => {
  const { en, manager } = await loadI18n();
  const chat = en.chat;
  const labels = [
    ["chat.sendShortcut", "Send shortcut"],
    ["chat.followUpModeQueue", "Queue until the run ends"],
    ["chat.catalogOpenTarget", "Open external sessions in"],
  ] as const;
  for (const [key] of labels) {
    expect(manager.t(key)).toBe(key);
  }
  expect(manager.t("chat.sendShortcutModifierEnter")).toBe("⌘/Ctrl+Enter");
  expect(manager.t("chat.followUpModeSteer")).toBe("Steer into the active run");
  await manager.setLocale("de");
  await import("../pages/config/settings-search.ts");
  for (const [key, text] of labels) {
    expect(manager.t(key)).toBe(text);
  }
  expect(en.chat).toBe(chat);
  expect(manager.t("common.health")).toBe("Gesundheit");
});
