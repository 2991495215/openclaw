import { describe, expect, it } from "vitest";
import { SessionCatalogLiveState } from "../../components/app-sidebar-session-catalog-live.ts";

describe("AppSidebar session catalog pagination", () => {
  it("keeps the current refetch guard when an older request finishes", () => {
    const live = new SessionCatalogLiveState();
    const older = live.beginRequest(1).requestOwner;
    live.setRequestPhase(older, "replay");
    const current = live.beginRequest(1).requestOwner;
    live.setRequestPhase(current, "replay");

    live.endRequest(older);
    expect(live.refetching).toBe(true);
    live.endRequest(current);
    expect(live.refetching).toBe(false);
  });

  it("invalidates request ownership when live state is cleared", () => {
    const live = new SessionCatalogLiveState();
    const first = live.beginRequest(1);
    live.clear();
    const second = live.beginRequest(1);

    expect(live.ownsRequest(first.requestOwner)).toBe(false);
    expect(live.ownsRequest(second.requestOwner)).toBe(true);
  });
});
