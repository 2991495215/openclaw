import { describe, expect, it } from "vitest";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import type { MsgContext } from "../templating.js";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";

const ctx: MsgContext = {
  ChatType: "channel",
  Provider: "slack",
  WasMentioned: true,
  MentionSource: "implicit_thread",
};

describe("source reply expectation", () => {
  it.each([
    { policy: "allow", overrides: {}, expected: "optional" },
    { policy: "disallow", overrides: {}, expected: "required" },
    { policy: undefined, overrides: {}, expected: "required" },
    { policy: "allow", overrides: { MentionSource: "explicit_bot" }, expected: "required" },
    { policy: "allow", overrides: { MentionSource: undefined }, expected: "required" },
    { policy: "allow", overrides: { CommandSource: "native" }, expected: "required" },
    { policy: "allow", overrides: { ChatType: "direct" }, expected: "required" },
    {
      policy: undefined,
      overrides: {
        Provider: INTERNAL_MESSAGE_CHANNEL,
        InternalTurnSource: "event",
        InputProvenance: { kind: "internal_system", sourceTool: "exec" },
      },
      expected: "required",
    },
    {
      policy: undefined,
      overrides: {
        Provider: INTERNAL_MESSAGE_CHANNEL,
        InputProvenance: { kind: "internal_system", sourceTool: "exec" },
      },
      expected: "result-required",
    },
    {
      policy: undefined,
      overrides: { Provider: INTERNAL_MESSAGE_CHANNEL, InternalTurnSource: "event" },
      expected: "result-required",
    },
  ] as const)(
    "selects $expected for $policy with $overrides",
    ({ policy, overrides, expected }) => {
      expect(
        resolveSourceReplyExpectation({
          ctx: { ...ctx, ...overrides },
          cfg: { surfaces: { slack: { silentReply: { group: policy } } } },
        }),
      ).toBe(expected);
    },
  );
});
