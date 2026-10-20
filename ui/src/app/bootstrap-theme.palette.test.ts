/* @vitest-environment jsdom */

import { createEffect, createRoot, flush } from "@solidjs/signals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectMcpAppStyleVariables } from "../components/mcp-app-theme.ts";
import { projectTheme } from "../lib/reactive/theme.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import { loadSettings, patchSettings, saveSettings } from "./settings.ts";

const disposals: Array<() => void> = [];
beforeEach((testContext) => {
  const existingFontLinks = new Set(document.querySelectorAll('link[id^="openclaw-typeface-"]'));
  testContext.onTestFinished(() => {
    for (const link of document.querySelectorAll('link[id^="openclaw-typeface-"]')) {
      if (!existingFontLinks.has(link)) {
        link.remove();
      }
    }
  });
});
afterEach(() => {
  for (const dispose of disposals.splice(0).toReversed()) {
    dispose();
  }
  document.querySelectorAll('[id^="openclaw-theme-palette-"]').forEach((link) => link.remove());
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_CONTENT_ZOOM__");
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__");
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_EMBED__");
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Reflect.deleteProperty(window, "chrome");
});

function setup() {
  const previous = loadSettings();
  saveSettings({ ...previous, theme: "claw", themeMode: "light" });
  disposals.push(() => saveSettings(previous));
  const { gateway } = createGatewayStoreTestStore({ settings: loadSettings() });
  disposals.push(() => gateway.stop());
  const theme = createApplicationTheme(loadSettings(), gateway);
  disposals.push(() => theme.dispose());
  const snapshots = vi.fn(() => ({
    theme: theme.settings.theme,
    mode: document.documentElement.dataset.themeMode,
    variables: collectMcpAppStyleVariables(),
  }));
  theme.subscribe(snapshots);
  return { theme, snapshots };
}

function pendingPalette() {
  const link = document.getElementById("openclaw-theme-palette-tide");
  expect(link).toBeInstanceOf(HTMLLinkElement);
  return link!;
}

describe("applied theme palette publication", () => {
  it.each([
    "native-desktop",
    "browser-desktop",
    "touch",
    "native-mobile",
    "unsupported-desktop",
    "touch-with-pointer",
    "unsupported-webview2",
    "native-without-import",
  ] as const)("uses one scaling owner without rewriting saved preferences on %s", (host) => {
    const previous = loadSettings();
    const touchDescriptor = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    disposals.push(() => {
      saveSettings(previous);
      if (touchDescriptor) {
        Object.defineProperty(navigator, "maxTouchPoints", touchDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "maxTouchPoints");
      }
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      value: host === "touch-with-pointer" ? 5 : 0,
    });
    saveSettings({ ...previous, textScale: 125, navWidth: 333, chatShowThinking: false });
    vi.stubGlobal("matchMedia", (query: string) =>
      Object.assign(new EventTarget(), {
        media: query,
        matches:
          [
            "browser-desktop",
            "unsupported-desktop",
            "touch-with-pointer",
            "unsupported-webview2",
          ].includes(host) && query.includes("pointer: fine"),
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }),
    );
    const adoptLegacyTextScale = vi.fn().mockResolvedValue(undefined);
    if (host.startsWith("native-")) {
      Object.assign(window, {
        __OPENCLAW_NATIVE_WEB_CHROME__: true,
        __OPENCLAW_NATIVE_CONTENT_ZOOM__: {
          supported: true,
          ...(host === "native-without-import" ? {} : { adoptLegacyTextScale }),
        },
      });
      if (host === "native-mobile") {
        Object.assign(window, {
          __OPENCLAW_NATIVE_EMBED__: { platform: "ios", formFactor: "phone" },
        });
      }
    }
    if (host === "unsupported-desktop") {
      Object.assign(window, { __TAURI_INTERNALS__: {} });
    }
    if (host === "unsupported-webview2") {
      Object.assign(window, { chrome: { webview: {} } });
    }
    const { theme } = setup();
    const scale = () => document.documentElement.style.getPropertyValue("--control-ui-text-scale");
    const expected = ["native-desktop", "native-without-import", "browser-desktop"].includes(host)
      ? "1"
      : "1.25";
    expect(scale()).toBe(expected);
    expect(loadSettings()).toMatchObject({
      textScale: 125,
      navWidth: 333,
      chatShowThinking: false,
    });
    patchSettings({ themeMode: "dark" });
    theme.refresh();
    expect(scale()).toBe(expected);
    expect(loadSettings()).toMatchObject({
      textScale: 125,
      navWidth: 333,
      chatShowThinking: false,
    });
    if (host === "native-desktop") {
      expect(adoptLegacyTextScale).toHaveBeenCalledExactlyOnceWith(125);
    } else {
      expect(adoptLegacyTextScale).not.toHaveBeenCalled();
    }
  });

  it("projects immediate preferences separately from the applied palette", () => {
    const { theme } = setup();
    const projection = projectTheme(theme);
    const preferences: string[] = [];
    const palettes: string[] = [];
    const dispose = createRoot((stop) => {
      createEffect(
        () => projection.preferences.read().theme,
        (value) => {
          preferences.push(value);
        },
      );
      createEffect(
        () => projection.appliedPalette.read()?.theme,
        (value) => {
          palettes.push(value ?? "none");
        },
      );
      return stop;
    });
    disposals.push(dispose, projection.dispose);
    flush();
    patchSettings({ theme: "tide", themeMode: "dark" });
    flush();
    expect(preferences).toEqual(["claw", "tide"]);
    expect(palettes).toEqual(["claw"]);
    pendingPalette().dispatchEvent(new Event("load"));
    flush();
    expect(preferences).toEqual(["claw", "tide"]);
    expect(palettes).toEqual(["claw", "tide"]);
    projection.dispose();
    patchSettings({ theme: "claw" });
    flush();
    expect(palettes).toEqual(["claw", "tide"]);
  });

  it.each(["synchronous", "load", "error"])(
    "publishes the applied palette with %s completion without a branding change",
    (event) => {
      const { snapshots } = setup();
      const mascot = document.documentElement.dataset.themeMascot;
      document.documentElement.style.setProperty("--card", "#ffffff");
      patchSettings({ theme: event === "synchronous" ? "claw" : "tide", themeMode: "dark" });
      expect(snapshots).toHaveBeenCalledOnce();
      if (event === "synchronous") {
        expect(snapshots).toHaveLastReturnedWith(expect.objectContaining({ mode: "dark" }));
        return;
      }
      expect(snapshots).toHaveNthReturnedWith(
        1,
        expect.objectContaining({
          theme: "tide",
          mode: "light",
          variables: expect.objectContaining({ "--color-background-primary": "#ffffff" }),
        }),
      );
      // The browser installs the stylesheet before delivering its load event.
      document.documentElement.style.setProperty("--card", "#16202b");
      if (event === "error") {
        vi.spyOn(console, "error").mockImplementation(() => {});
      }
      pendingPalette().dispatchEvent(new Event(event));
      expect(document.documentElement.dataset.themeMascot).toBe(mascot);
      expect(snapshots).toHaveBeenCalledTimes(2);
      expect(snapshots).toHaveNthReturnedWith(
        2,
        expect.objectContaining({
          theme: "tide",
          mode: "dark",
          variables: expect.objectContaining({ "--color-background-primary": "#16202b" }),
        }),
      );
    },
  );

  it.each(["superseded", "disposed"])("ignores a %s palette completion", (state) => {
    const { theme, snapshots } = setup();
    patchSettings({ theme: "tide", themeMode: "dark" });
    const link = pendingPalette();
    if (state === "disposed") {
      theme.dispose();
    } else {
      patchSettings({ theme: "claw", themeMode: "light" });
    }
    snapshots.mockClear();
    link.dispatchEvent(new Event("load"));
    expect(snapshots).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.themeMode).toBe("light");
  });
});
