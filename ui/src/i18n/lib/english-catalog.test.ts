// @vitest-environment node
import { createEffect, createRoot, flush } from "@solidjs/signals";
import { expect, it, vi } from "vitest";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { registerBoardWebsiteEnglish } from "../locales/en-board-website.ts";
import { registerBoardEnglish } from "../locales/en-board.ts";
import { registerChatSessionEnglish } from "../locales/en-chat-session.ts";
import { registerProviderUsageEnglish } from "../locales/en-provider-usage.ts";
import { registerUsageEnglish } from "../locales/en-usage.ts";
import { en } from "../locales/en.ts";
import { loadLazyLocaleTranslation } from "./registry.ts";
import { captureI18nStateForTesting } from "./translate.test-support.ts";
import { i18n } from "./translate.ts";
import type { TranslationMap } from "./types.ts";

vi.hoisted(() => vi.resetModules());

it("keeps shared session labels eager while lazy renderers extend their retained namespaces", async () => {
  const restoreI18n = captureI18nStateForTesting();
  const snapshots: { target: TranslationMap; value: TranslationMap }[] = [];
  function remember(target: TranslationMap): void {
    snapshots.push({ target, value: { ...target } });
    for (const value of Object.values(target)) {
      if (typeof value !== "string") {
        remember(value);
      }
    }
  }
  remember(en.chat);
  const details = en.chat.sessionDetails;
  const diff = en.chat.sessionDiff;
  try {
    await i18n.setLocale("en");
    expect(t("chat.sessionDetails.progressOptions")).toBe("Task progress options");
    expect(t("chat.sessionDiff.title")).toBe("Changes");
    expect(t("chat.activityPills.label")).toBe("chat.activityPills.label");

    registerEnglishCatalog(registerChatSessionEnglish);
    expect(t("chat.activityPills.label")).toBe("Session activity");
    expect(t("chat.sessionDiff.modeUnified")).toBe("Unified");
    expect(en.chat.sessionDetails).toBe(details);
    expect(en.chat.sessionDiff).toBe(diff);
  } finally {
    for (const { target, value } of snapshots) {
      for (const key of Object.keys(target)) {
        if (!Object.hasOwn(value, key)) {
          Reflect.deleteProperty(target, key);
        }
      }
      Object.assign(target, value);
    }
    await restoreI18n();
  }
});

it.each([
  {
    register: registerBoardWebsiteEnglish,
    activeKey: "websiteOpen",
    activeText: "Webseite öffnen",
    fallbackKey: "websiteEmbedHint",
    fallbackText: "If this site does not load here, open it in a new tab.",
  },
  {
    register: registerBoardEnglish,
    activeKey: "appLoading",
    activeText: "App wird wiederhergestellt…",
    fallbackKey: "errorDetail",
    fallbackText: "The problem is contained to this card.",
  },
])(
  "invalidates public t for lazy $activeKey fallback without replacing active translations",
  async ({ register, activeKey, activeText, fallbackKey, fallbackText }) => {
    const restoreI18n = captureI18nStateForTesting();
    const originalGerman = await loadLazyLocaleTranslation("de");
    const widget = en.board.widget;
    const originalWidget = { ...widget };
    const labels: (readonly string[])[] = [];
    let dispose = () => {};
    try {
      i18n.registerTranslation("de", { board: { widget: { [activeKey]: activeText } } });
      await i18n.setLocale("de");
      dispose = createRoot((stop) => {
        createEffect(
          () => [t(`board.widget.${activeKey}`), t(`board.widget.${fallbackKey}`)],
          (value) => {
            labels.push(value);
          },
        );
        return stop;
      });
      flush();
      expect(labels).toEqual([[activeText, `board.widget.${fallbackKey}`]]);

      registerEnglishCatalog<ReturnType<typeof register>>(register);
      flush();
      expect(labels.at(-1)).toEqual([activeText, fallbackText]);
      expect(en.board.widget).toBe(widget);
      const count = labels.length;
      registerEnglishCatalog<ReturnType<typeof register>>(register);
      flush();
      expect(labels).toHaveLength(count);
    } finally {
      dispose();
      for (const key of Object.keys(widget)) {
        if (!Object.hasOwn(originalWidget, key)) {
          Reflect.deleteProperty(widget, key);
        }
      }
      Object.assign(widget, originalWidget);
      if (originalGerman) {
        i18n.registerTranslation("de", originalGerman);
      }
      await restoreI18n();
    }
  },
);

it("loads optional usage copy without replacing shared labels or retained provider namespaces", async () => {
  const restoreI18n = captureI18nStateForTesting();
  const originalUsage = { ...en.usage };
  const details = en.usage.details;
  const providerUsage = en.usage.providerUsage;
  const originalDetails = { ...details };
  const originalOverview = { ...en.usage.overview };
  const originalProviderUsage = { ...providerUsage };
  try {
    await i18n.setLocale("en");
    expect(t("usage.details.collapse")).toBe("Collapse");
    expect(t("usage.common.emptyValue")).toBe("—");
    expect(t("usage.heatmap.title")).toBe("Token Activity");
    expect(t("usage.details.noTimeline")).toBe("usage.details.noTimeline");
    expect(t("usage.providerUsage.remaining")).toBe("usage.providerUsage.remaining");

    registerEnglishCatalog(registerProviderUsageEnglish);
    expect(t("usage.providerUsage.remaining", { percent: "75" })).toBe("75% left");
    expect(t("usage.details.noTimeline")).toBe("usage.details.noTimeline");

    registerEnglishCatalog(registerUsageEnglish);
    expect(t("usage.details.noTimeline")).toBe("No timeline data");
    expect(t("usage.details.collapse")).toBe("Collapse");
    expect(en.usage.details).toBe(details);
    expect(en.usage.providerUsage).toBe(providerUsage);
  } finally {
    for (const [target, original] of [
      [en.usage, originalUsage],
      [details, originalDetails],
      [en.usage.overview, originalOverview],
      [providerUsage, originalProviderUsage],
    ]) {
      for (const key of Object.keys(target)) {
        if (!Object.hasOwn(original, key)) {
          Reflect.deleteProperty(target, key);
        }
      }
      Object.assign(target, original);
    }
    await restoreI18n();
  }
});
