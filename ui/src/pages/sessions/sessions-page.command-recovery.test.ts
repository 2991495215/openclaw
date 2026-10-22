/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  openSubmenu,
  selectMenuValue,
  settleSessionMenu,
} from "../../test-helpers/session-menu.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, createGateway, createRenderedPage } from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

describe("sessions page lifecycle", () => {
  it("clears failed command feedback on Refresh and retry while retaining roster read errors", async () => {
    const target: GatewaySessionRow = {
      key: "agent:main:retry-command",
      sessionId: "retry-command-id",
      kind: "direct",
      label: "Retry command fixture",
      updatedAt: 1,
    };
    let rows = [target];
    let deletionAttempts = 0;
    let readFails = false;
    const connection = createGateway(
      createTestGatewayClient((method) => {
        if (method === "sessions.list") {
          if (readFails) {
            throw new Error("Roster unavailable. Refresh to recover.");
          }
          return sessionsResult(rows, 1);
        }
        if (method === "sessions.delete") {
          deletionAttempts += 1;
          if (deletionAttempts < 3) {
            throw new Error("Deletion unavailable. Try again.");
          }
          rows = [];
          readFails = true;
          return { deleted: true };
        }
        throw new Error(`Unexpected request: ${method}`);
      }),
    );
    const sessions = createTestSessionCapability(connection.gateway);
    const page = await createRenderedPage(
      createContext(connection.gateway, sessions),
      sessionsResult(rows, 1),
      "all",
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const remove = async () => {
      page.openSessionMenu(target, { x: 10, y: 20 }, document.createElement("button"));
      await page.updateComplete;
      const menu =
        page.querySelector<HTMLElementTagNameMap["openclaw-session-menu"]>(
          "openclaw-session-menu",
        )!;
      expect(menu).not.toBeNull();
      await settleSessionMenu(menu);
      await openSubmenu(menu, "Advanced");
      await selectMenuValue(menu, "delete");
    };
    const refresh = () => page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;

    try {
      await remove();
      await waitForFast(() =>
        expect(page.textContent).toContain("Deletion unavailable. Try again."),
      );
      refresh().click();
      await waitForFast(() =>
        expect(page.textContent).not.toContain("Deletion unavailable. Try again."),
      );

      await remove();
      await waitForFast(() =>
        expect(page.textContent).toContain("Deletion unavailable. Try again."),
      );
      await remove();
      await waitForFast(() =>
        expect(page.textContent).toContain("Roster unavailable. Refresh to recover."),
      );
      expect(page.textContent).not.toContain("Deletion unavailable. Try again.");
      expect(deletionAttempts).toBe(3);

      readFails = false;
      refresh().click();
      await waitForFast(() => expect(page.querySelector('[role="alert"]')).toBeNull());
    } finally {
      page.remove();
      sessions.dispose();
    }
  });
});
