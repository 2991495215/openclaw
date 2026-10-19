import { describe, expect, it } from "vitest";
import { throwCollectedErrors } from "./collected-errors.js";

describe("throwCollectedErrors", () => {
  it("does nothing when there are no failures and preserves a sole thrown value", () => {
    expect(() => throwCollectedErrors([], "cleanup failed")).not.toThrow();
    const failure = { message: "foreign thrown value" };
    try {
      throwCollectedErrors([failure], "cleanup failed");
      expect.unreachable("expected the original failure");
    } catch (error) {
      expect(error).toBe(failure);
    }
  });

  it("aggregates every failure in order with the caller's message and cause", () => {
    const first = new Error("first");
    const second = new Error("second");
    try {
      throwCollectedErrors([first, second], "cleanup failed", { cause: first });
      expect.unreachable("expected independent failures to be aggregated");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        message: "cleanup failed",
        cause: first,
        errors: [first, second],
      });
    }
  });
});
