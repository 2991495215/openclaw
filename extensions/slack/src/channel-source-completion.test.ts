import { describe, expect, it } from "vitest";
import { slackPlugin } from "./channel.js";

describe("Slack current-source target matching", () => {
  const toolContext = {
    currentChannelProvider: "slack",
    currentChannelId: "team:T123:channel:C123",
    currentMessagingTarget: "team:T123:channel:C123",
  };

  it.each(["C123", "channel:C123", "team:T123:channel:C123"])(
    "recognizes the current conversation as %s",
    (target) => {
      expect(slackPlugin.threading?.matchesToolContextTarget?.({ target, toolContext })).toBe(true);
    },
  );

  it.each(["C999", "team:T999:channel:C123"])("rejects another destination %s", (target) => {
    expect(slackPlugin.threading?.matchesToolContextTarget?.({ target, toolContext })).toBe(false);
  });

  it("rejects a bare destination when the current workspace is ambiguous", () => {
    expect(
      slackPlugin.threading?.matchesToolContextTarget?.({
        target: "C123",
        toolContext: { ...toolContext, currentMessagingTarget: "team:T999:channel:C123" },
      }),
    ).toBe(false);
  });
});
