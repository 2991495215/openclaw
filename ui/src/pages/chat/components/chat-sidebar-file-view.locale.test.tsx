/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../../i18n/lib/translate.test-support.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../../../test-helpers/native-gateways.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import "./chat-detail-panel.tsx";

it("names the icon-only editor menu trigger in the active locale", async () => {
  const restoreI18n = captureI18nStateForTesting();
  registerFilePreviewEnglish();
  await i18n.setLocale("de");
  setNativeGatewayTestState("local");
  const panel = document.createElement("openclaw-chat-detail-panel");
  panel.filePresentation = "mobile";
  panel.content = { kind: "file", path: "/workspace/notes.md", name: "notes.md", content: "" };
  const container = createChatSidebarContainer();
  onTestFinished(async () => {
    container.remove();
    await Promise.resolve();
    flush();
    clearNativeGatewayTestState();
    await restoreI18n();
  });
  container.append(panel);
  document.body.append(container);
  await panel.updateComplete;
  const trigger = () => panel.querySelector(".sidebar-file-view__action");
  const german = t("chat.detailPanel.openInEditor");
  await waitForSolid(() => expect(trigger()?.getAttribute("aria-label")).toBe(german));
  expect(trigger()?.getAttribute("title")).toBe(german);

  await i18n.setLocale("en");
  const english = t("chat.detailPanel.openInEditor");
  expect(english).not.toBe(german);
  await waitForSolid(() => expect(trigger()?.getAttribute("aria-label")).toBe(english));
  expect(trigger()?.getAttribute("title")).toBe(english);
});
