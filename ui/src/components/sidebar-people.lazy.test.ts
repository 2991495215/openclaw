/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { selectSidebarView, setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createGatewayHarness, createSessions, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import "./app-sidebar.tsx";

const coldImport = vi.hoisted(() => ({
  started: Promise.withResolvers<void>(),
  ready: Promise.withResolvers<void>(),
}));

// Hold delivery after dependencies load, not the renderer or event handling.
vi.mock("./sidebar-people.runtime.ts", async (importOriginal) => {
  const module = await importOriginal<typeof import("./sidebar-people.runtime.ts")>();
  coldImport.started.resolve();
  await coldImport.ready.promise;
  return module;
});

setupSidebarTest();

async function mountPeople() {
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({ profiles: [] })));
  const mounted = await mountSidebar(gateway.gateway, createSessions("main", ["agent:main:work"]));
  mounted.sidebar.connected = true;
  await selectSidebarView(mounted.sidebar, "online");
  gateway.publishEvent("presence", {
    presence: ["alice", "bob"].map((id) => ({
      ts: Date.now(),
      user: { id, name: id === "alice" ? "Alice" : "Bob" },
    })),
  });
  await settleLitElement(mounted.sidebar);
  return {
    ...mounted,
    gateway,
    alice: mounted.sidebar.querySelector<HTMLElement>('[data-online-user-id="alice"]')!,
    bob: mounted.sidebar.querySelector<HTMLElement>('[data-online-user-id="bob"]')!,
  };
}

const card = () => document.querySelector<HTMLElement>(".person-activity-hovercard");

describe("sidebar people lazy input", () => {
  it("keeps the latest click modality when cold loading crosses repeated targets", async () => {
    const { sidebar, alice, bob } = await mountPeople();
    const matchMediaBefore = globalThis.matchMedia.bind(globalThis);
    vi.spyOn(globalThis, "matchMedia").mockImplementation((query) => {
      const result = matchMediaBefore(query);
      return { ...result, matches: query === "(hover: hover)" || result.matches };
    });
    alice.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    await coldImport.started.promise;
    try {
      bob.click();
      alice.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      alice.click();
      expect(card()).toBeNull();
    } finally {
      coldImport.ready.resolve();
    }
    await vi.dynamicImportSettled();
    await settleLitElement(sidebar);
    expect(card()?.querySelector("h2")?.textContent).toBe("Alice");
    bob.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    await settleLitElement(sidebar);
    expect(card()?.querySelector("h2")?.textContent).toBe("Alice");
    alice.click();
    expect(card()).toBeNull();
  });

  it.each(["Escape", "outside"])("cancels pending input on %s and can reopen", async (reason) => {
    const { sidebar, alice, bob } = await mountPeople();
    alice.click();
    if (reason === "Escape") {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } else {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    }
    await vi.dynamicImportSettled();
    await settleLitElement(sidebar);
    expect(card()).toBeNull();
    bob.click();
    await vi.dynamicImportSettled();
    await settleLitElement(sidebar);
    expect(card()?.querySelector("h2")?.textContent).toBe("Bob");
  });

  it.each(["disconnect", "detach"])("does not activate a pending %s target", async (reason) => {
    const { sidebar, gateway, alice } = await mountPeople();
    alice.click();
    if (reason === "disconnect") {
      gateway.publish({ phase: "reconnecting" });
    } else {
      alice.remove();
    }
    await vi.dynamicImportSettled();
    await settleLitElement(sidebar);
    expect(card()).toBeNull();
  });
});
