/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

describe("command discovery English loading", () => {
  it.each([
    {
      surface: "palette search",
      load: () => import("../components/command-palette-catalog-search.ts"),
    },
    { surface: "session transcript search", load: () => import("../pages/sessions/view.tsx") },
    { surface: "shortcut help", load: () => import("../lib/keyboard-shortcut-catalog.ts") },
  ])("registers fallback copy before $surface reads it", async ({ load }) => {
    const { manager } = await loadI18n();
    expect(manager.t("palette.placeholder")).toBe("Search or start a task…");
    expect(manager.t("palette.categories.navigation")).toBe("Navigation");
    expect(manager.t("shortcutsOverlay.title")).toBe("Keyboard shortcuts");
    expect(manager.t("commandPalette.newSessionSettings")).toBe(
      "commandPalette.newSessionSettings",
    );
    await manager.setLocale("de");
    await load();
    const { registerCommandPaletteEnglish } = await import("./locales/en-command-palette.ts");
    for (const [key, value] of flattenTranslations(registerCommandPaletteEnglish.catalog)) {
      expect(manager.t(key)).toBe(value);
    }
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(manager.t("commandPalette.newSessionSettings")).toBe("New session settings");
    expect(manager.t("chat.commands.menu")).toBe("Slash commands");
  });

  it("keeps chat commands, welcome text, and account choices independent of optional catalogs", async () => {
    const { manager } = await loadI18n();
    await manager.setLocale("de");
    const { SLASH_COMMANDS, getSlashCommandDescription } = await import("../lib/chat/commands.ts");
    expect(manager.t("chat.welcome.recentSessions")).toBe("chat.welcome.recentSessions");
    await import("../pages/chat/components/chat-welcome.tsx");
    await import("../pages/chat/components/chat-model-account-control.ts");

    expect(manager.t("chat.commands.menu")).toBe("Slash commands");
    expect(manager.t("chat.welcome.recentSessions")).toBe("Recent chats");
    expect(manager.t("profilePage.modelAccounts.loadMore")).toBe("Load more saved accounts");
    expect(manager.t("profilePage.modelAccounts.inventoryFailed")).toBe(
      "Could not load saved accounts. Refresh to retry.",
    );
    const steer = SLASH_COMMANDS.find((command) => command.key === "steer");
    expect(steer?.description).toBe("Inject a message into the active run");
    expect(steer && getSlashCommandDescription(steer)).toBe("Inject a message into the active run");
    expect(manager.t("commandPalette.newSessionSettings")).toBe(
      "commandPalette.newSessionSettings",
    );
    expect(manager.t("profilePage.modelAccounts.addAccount")).toBe(
      "profilePage.modelAccounts.addAccount",
    );
    expect(manager.t("common.health")).toBe("Gesundheit");
  });
});
