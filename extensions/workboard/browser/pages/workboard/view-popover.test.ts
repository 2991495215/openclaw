import { createRoot, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { workboardPopoverRef } from "./view-popover.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([false, true])("anchors and retires a late-trigger popover (hover=%s)", (hover) => {
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const trigger = document.createElement("button");
  const panel = document.createElement("div");
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(300, 100, 40, 20));
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 100));
  vi.spyOn(panel, "matches").mockImplementation((selector) => selector === ":popover-open");
  let dispose!: () => void;
  createRoot((cleanup) => {
    dispose = cleanup;
    workboardPopoverRef("end", hover)(panel);
    document.body.append(trigger, panel);
  });
  flush();
  panel.dispatchEvent(new Event("toggle"));
  expect(panel.style.left).toBe("140px");
  expect(panel.style.top).toBe("126px");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  dispose();
  panel.style.left = "";
  panel.style.top = "";
  trigger.removeAttribute("aria-expanded");
  panel.dispatchEvent(new Event("toggle"));
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("scroll"));
  expect(panel.style.left).toBe("");
  expect(panel.style.top).toBe("");
  expect(trigger.hasAttribute("aria-expanded")).toBe(false);
  const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  panel.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(false);
  vi.spyOn(panel, "matches").mockReturnValue(false);
  const show = vi.spyOn(panel, "showPopover");
  trigger.dispatchEvent(new Event("focusin"));
  expect(show).not.toHaveBeenCalled();
});
