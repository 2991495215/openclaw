/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("keeps shared session labels readable without loading organization menus", async () => {
  const { en, manager } = await loadI18n({
    sessionsView: { pinRootSessionsOnly: "Nur übergeordnete Sitzungen anheften" },
  });
  const sessions = en.sessionsView;
  await manager.setLocale("de");

  expect(manager.t("sessionsView.goal")).toBe("sessionsView.goal");

  await import("../components/session-menu-access.ts");
  const { formatSessionArchiveReason } = await import("../lib/sessions/session-archive-reason.ts");
  await import("../lib/sessions/session-menu-navigation.ts");
  await import("../pages/chat/chat-pane-native-session-actions.ts");
  await import("../pages/chat/chat-pane-placement.ts");

  expect(manager.t("sessionsView.groupDefaultsTitle")).toBe("sessionsView.groupDefaultsTitle");
  expect(formatSessionArchiveReason("manual")).toBe("Archived manually");
  expect(manager.t("sessionsView.goal")).toBe("Goal");
  expect(manager.t("sessionsView.moveSessionTitle")).toBe("Move session");
  expect(manager.t("sessionsView.newGroupTitle")).toBe("New group");
  expect(manager.t("sessionsView.copyTranscriptChanged")).toBe(
    "Conversation changed while copying. Try again.",
  );
  expect(manager.t("sessionsView.stopCloudWorkerConfirm", { session: "Example" })).toBe(
    'Stop the cloud worker for "Example"?',
  );
  expect(manager.t("sessionsView.stopCloudWorkerConfirmAction")).toBe("Stop worker");
  expect(manager.t("sessionsView.pinRootSessionsOnly")).toBe(
    "Nur übergeordnete Sitzungen anheften",
  );

  await import("../components/session-group-defaults-dialog.tsx");
  expect(manager.t("sessionsView.groupDefaultsTitle", { group: "Example" })).toBe(
    'New session defaults for "Example"',
  );
  expect(manager.t("sessionsView.pinRootSessionsOnly")).toBe(
    "Nur übergeordnete Sitzungen anheften",
  );
  expect(en.sessionsView).toBe(sessions);
});
