import { afterEach, describe, expect, it, vi } from "vitest";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "../test-helpers/load-styles.ts";
import "./catalog-session-menu.ts";
import type { CatalogSessionMenuAction } from "./catalog-session-menu.ts";

type Menu = HTMLElement & {
  x: number;
  y: number;
  trigger: HTMLElement;
  canOpenOriginal: boolean;
  terminalDisabled: boolean;
  onAction: (action: CatalogSessionMenuAction) => void;
  onClose: () => void;
  updateComplete: Promise<boolean>;
};

const containers: HTMLElement[] = [];
afterEach(async () => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
  await Promise.resolve();
});

describe.skipIf(typeof HTMLElement.prototype.showPopover !== "function")(
  "catalog menu entry point",
  () => {
    it.each([false, true])(
      "keeps the configured=%s menu visible and restores focus across reopening",
      async (configured) => {
        const { page, userEvent } = await import("vitest/browser");
        await page.viewport(640, 560);
        const container = document.createElement("div");
        containers.push(container);
        const trigger = document.createElement("button");
        trigger.textContent = "Session actions";
        container.append(trigger);
        document.body.append(container);
        await page.elementLocator(trigger).hover();
        // The production caller reaches this same registered tag through its shim.
        const menu = document.createElement("openclaw-catalog-session-menu") as Menu;
        menu.x = window.innerWidth;
        menu.y = window.innerHeight;
        menu.trigger = trigger;
        menu.canOpenOriginal = configured;
        menu.terminalDisabled = true;
        const order: string[] = [];
        menu.onAction = (action) => order.push(action);
        const close = vi.fn(() => {
          order.push("close");
          menu.remove();
        });
        menu.onClose = close;
        container.append(menu);
        await menu.updateComplete;
        const dropdown = menu.querySelector("wa-dropdown")!;
        await dropdown.updateComplete;
        const first = menu.querySelector("wa-dropdown-item")!;
        await expect.poll(() => document.activeElement).toBe(first);
        const surface = dropdown.shadowRoot!.querySelector<HTMLElement>('[part="menu"]')!;
        await expect
          .poll(() => {
            const bounds = surface.getBoundingClientRect();
            return (
              bounds.width > 0 &&
              bounds.height > 0 &&
              bounds.left >= 0 &&
              bounds.top >= 0 &&
              bounds.right <= window.innerWidth &&
              bounds.bottom <= window.innerHeight
            );
          })
          .toBe(true);
        expect(menu.querySelector('[value="original"]') !== null).toBe(configured);
        dropdown.dispatchEvent(
          new CustomEvent("wa-select", {
            detail: { item: { value: "unknown-action" } },
            bubbles: true,
            cancelable: true,
          }),
        );
        expect(order).toEqual([]);
        await userEvent.keyboard("{Escape}");
        expect(close).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(trigger);
        await Promise.resolve();
        await userEvent.keyboard("{Escape}");
        expect(close).toHaveBeenCalledTimes(1);
        order.length = 0;
        container.append(menu);
        await menu.updateComplete;
        await expect
          .poll(() => document.activeElement)
          .toBe(menu.querySelector("wa-dropdown-item"));
        const action = configured ? "original" : "viewer";
        await page.elementLocator(menu.querySelector<HTMLElement>(`[value="${action}"]`)!).click();
        expect(order).toEqual([action, "close"]);
        expect(menu.isConnected).toBe(false);
      },
    );
  },
);
