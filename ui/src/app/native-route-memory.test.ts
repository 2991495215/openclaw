import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { considerRouteRestore, persistRoute } from "./native-route-memory.ts";

let storage: Storage;
const { nativeHost } = vi.hoisted(() => ({ nativeHost: vi.fn(() => true) }));

vi.mock("./native-web-chrome.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-web-chrome.ts")>()),
  isNativeWebChromeHost: nativeHost,
}));

beforeEach(() => {
  storage = createStorageMock();
  vi.stubGlobal("localStorage", storage);
  nativeHost.mockReturnValue(true);
});

afterEach(() => vi.unstubAllGlobals());

describe("native route memory", () => {
  it("persists and restores known routes", () => {
    persistRoute("usage", "/usage", "?agent=main");
    expect(considerRouteRestore("chat", "/chat", "")).toEqual({
      routeId: "usage",
      pathname: "/usage",
      search: "?agent=main",
    });
  });

  it.each([
    "{",
    ...["retired", "__proto__"].map((routeId) =>
      JSON.stringify({ routeId, pathname: `/${routeId}`, search: "" }),
    ),
  ])("drops corrupt or invalid entry %s", (raw) => {
    storage.setItem("openclaw.native.lastRoute", raw);
    expect(considerRouteRestore("chat", "/chat", "")).toBeNull();
    expect(storage.getItem("openclaw.native.lastRoute")).toBeNull();
  });

  it("does nothing outside the native host", () => {
    nativeHost.mockReturnValue(false);
    storage.setItem(
      "openclaw.native.lastRoute",
      JSON.stringify({ routeId: "usage", pathname: "/usage", search: "" }),
    );
    persistRoute("chat", "/chat/main", "");
    expect(considerRouteRestore("chat", "/chat", "")).toBeNull();
    expect(JSON.parse(storage.getItem("openclaw.native.lastRoute") ?? "{}")).toEqual({
      routeId: "usage",
      pathname: "/usage",
      search: "",
    });
  });

  it("skips restoring the route it is already on", () => {
    persistRoute("chat", "/chat", "");
    expect(considerRouteRestore("chat", "/chat", "")).toBeNull();
  });
});
