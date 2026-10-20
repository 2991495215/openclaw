import { describe, expect, it } from "vitest";
import { hostDesktopSetupHref, readHostDesktopSetupNavigation } from "./systems-navigation.ts";

describe("host desktop setup navigation", () => {
  it("keeps a base-path-scoped desktop return and explicit Gateway intent", () => {
    const href = hostDesktopSetupHref("/team", "/team/focus/desktop/source/gateway");
    expect(href).toBe(
      "/team/systems?desktopSetup=gateway&returnTo=%2Fteam%2Ffocus%2Fdesktop%2Fsource%2Fgateway",
    );
    expect(
      readHostDesktopSetupNavigation(new URL(href, "https://gateway.test").search, "/team"),
    ).toEqual({
      returnTo: { routeId: null, pathname: "/team/focus/desktop/source/gateway" },
    });
    expect(readHostDesktopSetupNavigation("?returnTo=%2Fteam%2Fchat", "/team")).toBeNull();
  });

  it.each([
    "https://other.test/chat",
    "//other.test/chat",
    "/chat",
    "/team/chat?token=synthetic",
    "/team/chat#synthetic",
    "/team/systems",
    "/team/not-a-page",
  ])("does not offer an unsafe or unrelated return to %s", (returnTo) => {
    const search = new URLSearchParams({ desktopSetup: "gateway", returnTo }).toString();
    expect(readHostDesktopSetupNavigation(search, "/team")).toEqual({ returnTo: null });
  });
});
