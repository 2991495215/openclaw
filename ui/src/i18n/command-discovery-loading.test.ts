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
    { surface: "shortcut help", load: () => import("../components/keyboard-shortcuts-dialog.tsx") },
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

  it.each([
    { surface: "slash commands", load: () => import("../lib/chat/commands.ts") },
    { surface: "chat welcome", load: () => import("../pages/chat/components/chat-welcome.tsx") },
  ])("loads $surface copy without opening discovery catalogs", async ({ load }) => {
    const { en, manager } = await loadI18n({
      common: { health: "Gesundheit" },
      chat: { commands: { menu: "Befehle" } },
    });
    const commands = en.chat.commands;
    const welcome = en.chat.welcome;
    await manager.setLocale("de");

    await load();

    expect(manager.t("chat.commands.menu")).toBe("Befehle");
    expect(manager.t("chat.commands.arguments")).toBe("Command arguments");
    expect(manager.t("chat.welcome.hintBeforeShortcut")).toBe("Type a message below ·");
    expect(manager.t("chat.welcome.recentSessions")).toBe("Recent chats");
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(en.chat.commands).toBe(commands);
    expect(en.chat.welcome).toBe(welcome);
    for (const key of [
      "commandPalette.newSessionSettings",
      "palette.noResults",
      "sessionsView.transcriptSearchTitle",
      "shortcutsOverlay.labels.newSession",
    ]) {
      expect(manager.t(key)).toBe(key);
    }
  });
});
