import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";
import { registerCatalogMenuEnglish } from "./locales/en-catalog-menu.ts";
import { en } from "./locales/en.ts";

vi.hoisted(() => vi.resetModules());
let restoreI18n: () => Promise<void>;
const menuKeys = [
  "sessionMenu",
  "openInOpenClaw",
  "importToOpenClaw",
  "importComplete",
  "importUnchanged",
  "importIncomplete",
  "openImportedSession",
  "openInTerminal",
  "deleteSession",
  "deleteSessionConfirm",
  "terminalUnavailable",
] as const;

beforeEach(() => {
  restoreI18n = captureI18nStateForTesting();
  // Each consumer evaluates once; clear only its copy to prove the second consumer
  // registers independently of its already-loaded standalone renderer.
  for (const key of menuKeys) {
    Reflect.deleteProperty(en.chat.catalog, key);
  }
});
afterEach(async () => {
  registerCatalogMenuEnglish();
  await restoreI18n();
});

it.each([
  {
    surface: "standalone menu",
    load: () => import("../components/catalog-session-menu-solid.tsx"),
  },
  {
    surface: "sidebar menu",
    load: () => import("../components/app-sidebar-catalog-menu-view.tsx"),
  },
])(
  "loads fallback copy with the $surface without replacing active translations",
  async ({ load }) => {
    const manager = createI18nManagerForTesting(async () => ({
      chat: { catalog: { sessionMenu: "Sitzungsaktionen" } },
    }));
    const catalog = en.chat.catalog;
    for (const key of menuKeys) {
      expect(Reflect.has(catalog, key)).toBe(false);
    }
    expect(manager.t("chat.catalog.openOriginal")).toBe("Open original");
    expect(manager.t("chat.catalog.remoteViewOnly")).toBe(
      "This session is on a paired device and is view-only.",
    );
    expect(manager.t("chat.catalog.unsupportedViewOnly")).toBe(
      "This external session source is view-only.",
    );
    await manager.setLocale("de");
    expect(manager.t("chat.catalog.openInOpenClaw")).toBe("chat.catalog.openInOpenClaw");

    await load();

    expect(en.chat.catalog).toBe(catalog);
    for (const key of menuKeys) {
      expect(Reflect.get(catalog, key)).toEqual(expect.any(String));
    }
    expect(manager.t("chat.catalog.sessionMenu")).toBe("Sitzungsaktionen");
    expect(manager.t("chat.catalog.openInOpenClaw")).toBe("Open in OpenClaw");
    expect(manager.t("chat.catalog.importComplete", { count: 3 })).toBe(
      "Imported 3 transcript items.",
    );
    expect(manager.t("chat.catalog.openOriginal")).toBe("Open original");
  },
);
