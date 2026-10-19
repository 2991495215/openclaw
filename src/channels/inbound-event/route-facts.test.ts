import { describe, expect, it } from "vitest";
import { buildChannelInboundRouteFacts } from "./route-facts.js";

describe("buildChannelInboundRouteFacts", () => {
  const route = {
    agentId: "support",
    accountId: "account-a",
    dmScope: "per-channel-peer" as const,
    sessionKey: "agent:support:example:direct:peer",
    mainSessionKey: "agent:support:main",
    lastRoutePolicy: "main" as const,
  };

  it("projects only inbound facts, without imposing dispatch or persistence policy", () => {
    expect(buildChannelInboundRouteFacts(route)).toEqual({
      agentId: "support",
      accountId: "account-a",
      dmScope: "per-channel-peer",
      routeSessionKey: "agent:support:example:direct:peer",
    });
  });

  it("retains an explicit dispatch session without changing the resolved route", () => {
    expect(
      buildChannelInboundRouteFacts(route, { dispatchSessionKey: "dispatch:session" }),
    ).toEqual({
      agentId: "support",
      accountId: "account-a",
      dmScope: "per-channel-peer",
      routeSessionKey: "agent:support:example:direct:peer",
      dispatchSessionKey: "dispatch:session",
    });
    expect(route.sessionKey).toBe("agent:support:example:direct:peer");
  });
});
