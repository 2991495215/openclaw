/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../i18n/index.ts";
import "./catalog-session-menu.ts";
import type { CatalogSessionMenuAction } from "./catalog-session-menu.ts";

type CatalogMenuElement = HTMLElement & {
  updateComplete: Promise<boolean>;
  canOpenOriginal: boolean;
};
type CatalogMenuItem = HTMLElement & { disabled: boolean; updateComplete: Promise<unknown> };

const containers: HTMLElement[] = [];

afterEach(async () => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
  await i18n.setLocale("en");
});

describe("catalog session menu", () => {
  it("renders an anchored Web Awesome dropdown and focuses the first item", async () => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    render(
      html`<openclaw-catalog-session-menu .lastActive=${"57d"}></openclaw-catalog-session-menu>`,
      container,
    );
    const menu = container.querySelector("openclaw-catalog-session-menu") as CatalogMenuElement;
    await menu.updateComplete;
    const dropdown = menu.querySelector<HTMLElement & { open: boolean }>("wa-dropdown");
    const items = [...menu.querySelectorAll<CatalogMenuItem>("wa-dropdown-item")];

    await Promise.resolve();
    expect(dropdown?.open).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    expect(items.map((item) => item.getAttribute("value"))).toEqual(["viewer", "terminal"]);
    expect(menu.querySelector(".session-menu__info")?.textContent?.trim()).toBe("Last active 57d");
  });

  it.each(["terminal", "original"] as const)(
    "dispatches %s before synchronous close",
    async (action) => {
      const container = document.createElement("div");
      containers.push(container);
      document.body.append(container);
      let backingState: { open: true } | null = { open: true };
      const order: string[] = [];
      const onAction = vi.fn((selected: CatalogSessionMenuAction) => {
        order.push(backingState ? selected : "cleared");
      });
      render(
        html`<openclaw-catalog-session-menu
          .canOpenOriginal=${true}
          .onAction=${onAction}
          .onClose=${() => {
            backingState = null;
            order.push("close");
          }}
        ></openclaw-catalog-session-menu>`,
        container,
      );
      const menu = container.querySelector("openclaw-catalog-session-menu") as CatalogMenuElement;
      await menu.updateComplete;

      menu.querySelector<CatalogMenuItem>(`wa-dropdown-item[value="${action}"]`)?.click();

      expect(onAction).toHaveBeenCalledWith(action);
      expect(order).toEqual([action, "close"]);
      expect(backingState).toBeNull();
    },
  );

  it("disables terminal selection with the unavailable reason", async () => {
    const onAction = vi.fn();
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    render(
      html`<openclaw-catalog-session-menu
        .terminalDisabled=${true}
        .onAction=${onAction}
      ></openclaw-catalog-session-menu>`,
      container,
    );
    const menu = container.querySelector("openclaw-catalog-session-menu") as CatalogMenuElement;
    await menu.updateComplete;
    const terminal = menu.querySelector<CatalogMenuItem>('wa-dropdown-item[value="terminal"]');

    expect(terminal?.disabled).toBe(true);
    expect(terminal?.title).toBe("Terminal opening is unavailable for this session.");
    terminal?.click();
    expect(onAction).not.toHaveBeenCalled();
  });
  it("rejects unknown dropdown actions without dispatching or closing", async () => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      html`<openclaw-catalog-session-menu
        .onAction=${onAction}
        .onClose=${onClose}
      ></openclaw-catalog-session-menu>`,
      container,
    );
    const menu = container.querySelector("openclaw-catalog-session-menu") as CatalogMenuElement;
    await menu.updateComplete;
    menu.querySelector("wa-dropdown")?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "unknown-action" } },
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("updates original-link visibility and edge placement on the retained menu", async () => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    render(
      html`<openclaw-catalog-session-menu
        .x=${window.innerWidth}
        .y=${window.innerHeight}
      ></openclaw-catalog-session-menu>`,
      container,
    );
    const menu = container.querySelector("openclaw-catalog-session-menu") as CatalogMenuElement;
    await menu.updateComplete;
    const trigger = menu.querySelector<HTMLButtonElement>('button[slot="trigger"]')!;
    const topWithoutOriginal = Number.parseFloat(trigger.style.top);
    expect(menu.querySelector('[value="original"]')).toBeNull();
    menu.canOpenOriginal = true;
    await menu.updateComplete;
    expect(
      [...menu.querySelectorAll("wa-dropdown-item")].map((item) => item.getAttribute("value")),
    ).toEqual(["viewer", "original", "terminal"]);
    expect(Number.parseFloat(trigger.style.top)).toBeLessThan(topWithoutOriginal);
    expect(Number.parseFloat(trigger.style.left)).toBeGreaterThanOrEqual(8);
    menu.canOpenOriginal = false;
    await menu.updateComplete;
    expect(menu.querySelector('[value="original"]')).toBeNull();
    expect(Number.parseFloat(trigger.style.top)).toBe(topWithoutOriginal);
  });

  it("reactively translates the open menu without a caller property change", async () => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    render(
      html`<openclaw-catalog-session-menu .lastActive=${"57d"}></openclaw-catalog-session-menu>`,
      container,
    );
    const menu = container.querySelector("openclaw-catalog-session-menu") as CatalogMenuElement;
    await menu.updateComplete;
    const info = menu.querySelector(".session-menu__info")!;
    const english = info.textContent;
    await i18n.setLocale("de");
    await vi.waitFor(() =>
      expect(info.textContent?.trim()).toBe(t("sessionsView.lastActive", { time: "57d" })),
    );
    expect(info.textContent).not.toBe(english);
  });

  it("restores trigger focus on Escape and retires dismissal after disconnect", async () => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const trigger = document.createElement("button");
    container.append(trigger);
    const onClose = vi.fn();
    const menu = document.createElement("openclaw-catalog-session-menu") as CatalogMenuElement & {
      trigger: HTMLElement;
      onClose: () => void;
    };
    menu.trigger = trigger;
    menu.onClose = onClose;
    container.append(menu);
    await menu.updateComplete;
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(menu.querySelector("wa-dropdown-item")),
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    menu.remove();
    await Promise.resolve();
    onClose.mockClear();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    container.append(menu);
    await menu.updateComplete;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
