/* @vitest-environment jsdom */

import { createMemo, onSettled } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { SessionHovercardInput } from "./session-hovercard-solid.tsx";
import { createHovercard } from "./session-progress-hovercard.test-support.ts";

const renderer = vi.hoisted(() => ({
  ready: Promise.withResolvers<void>(),
  loads: 0,
  fail: false,
}));

// mock-isolation: Hold renderer settlement without importing its real eager dependencies.
vi.mock("./session-hovercard-solid.tsx", () => {
  renderer.loads += 1;
  function ReadyCard(props: { label?: string; onReady?: () => void }) {
    if (renderer.fail) {
      throw new Error("Synthetic preview failure");
    }
    onSettled(() => props.onReady?.());
    return <div class="session-hovercard">{props.label}</div>;
  }
  return {
    SessionHovercard(props: SessionHovercardInput & { onReady?: () => void }) {
      const ready = createMemo(() => renderer.ready.promise);
      return <ReadyCard label={(ready(), props.row?.label)} onReady={props.onReady} />;
    },
  };
});

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  flush();
  vi.useRealTimers();
});

it("hydrates titles before loading preview code and keeps pending or failed code inside its card", async () => {
  vi.useFakeTimers();
  const empty = createHovercard({ sessionKey: "agent:research:empty", card: null });
  empty.provider.lookupSidebarRow = null;
  await empty.mount();
  await empty.focus();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector(".session-progress-hovercard")).toBeNull();
  expect(renderer.loads).toBe(0);
  empty.provider.remove();
  await empty.provider.updateComplete;

  const h = createHovercard({
    sessionKey: "agent:research:main",
    triggerKind: "markdown",
  });
  await h.mount();
  const label = document.createElement("span");
  const unregister = h.provider.registerSessionTitleTarget(h.trigger, label);
  await waitForSolid(() => expect(h.trigger.textContent).toBe("Synthetic provider session"));
  expect(renderer.loads).toBe(0);

  await h.focus();
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() => expect(renderer.loads).toBe(1));
  const card = () => document.querySelector<HTMLElement>(".session-progress-hovercard");
  expect(card()?.getAttribute("role")).toBe("dialog");
  expect(card()?.querySelector('[role="status"]')?.textContent).toContain("Loading");

  h.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(card()).toBeNull();
  renderer.ready.resolve();
  await vi.dynamicImportSettled();
  flush();
  expect(card()).toBeNull();
  expect(h.trigger.isConnected).toBe(true);

  await h.focus();
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() => expect(card()?.textContent).toContain("research session"));
  expect(card()?.querySelector('[role="status"]')).toBeNull();
  h.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  renderer.fail = true;

  await h.focus();
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() => expect(card()?.querySelector('[role="alert"]')).not.toBeNull());
  expect(h.trigger.isConnected).toBe(true);
  renderer.fail = false;
  const retry = card()?.querySelector<HTMLButtonElement>("button");
  retry?.focus();
  retry?.click();
  await waitForSolid(() => expect(card()?.textContent).toContain("research session"));
  expect(document.activeElement).toBe(h.trigger);
  expect(renderer.loads).toBe(1);
  unregister();
});
