import { expect, it } from "vitest";
import { clearFollowupQueue, getFollowupQueue } from "./state.js";

it("retains resolved batching settings when a mode-only reservation updates the mailbox", () => {
  const key = "agent:main:queue-settings";
  try {
    const mailbox = getFollowupQueue(key, {
      mode: "followup",
      debounceMs: 125,
      cap: 3,
      dropPolicy: "new",
    });
    expect(getFollowupQueue(key, { mode: "collect" })).toBe(mailbox);
    expect(mailbox).toMatchObject({
      mode: "collect",
      debounceMs: 125,
      cap: 3,
      dropPolicy: "new",
    });
  } finally {
    clearFollowupQueue(key);
  }
});
