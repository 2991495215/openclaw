import { describe, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  settleWithCleanup,
  throwIfSettledRejected,
  throwSettledAggregate,
} from "./error-graph-internal.js";

describe("settleWithCleanup", () => {
  it("preserves the result and closes once after the operation settles", async () => {
    const events: string[] = [];
    const result = { value: "result" };
    const operation = Promise.resolve().then(() => {
      events.push("operation");
      return result;
    });
    await expect(
      settleWithCleanup(
        operation,
        () => {
          events.push("cleanup");
        },
        "cleanup failed",
      ),
    ).resolves.toBe(result);
    expect(events).toEqual(["operation", "cleanup"]);
  });

  it.each(["operation", "cleanup"] as const)(
    "preserves a sole raw %s rejection",
    async (source) => {
      let closed = 0;
      const operation = createDeferredCore();
      if (source === "operation") {
        operation.reject(undefined);
      } else {
        operation.resolve();
      }
      await expect(
        settleWithCleanup(
          operation.promise,
          () => {
            closed++;
            if (source === "cleanup") {
              const cleanup = createDeferredCore();
              cleanup.reject(undefined);
              return cleanup.promise;
            }
            return undefined;
          },
          "cleanup failed",
        ),
      ).rejects.toBeUndefined();
      expect(closed).toBe(1);
    },
  );

  it.each([
    { mode: undefined, first: undefined },
    { mode: "operation" as const, first: undefined },
    { mode: undefined, first: new Error("operation failed") },
    { mode: "operation" as const, first: new Error("operation failed") },
  ])("retains both errors and the selected cause: $mode / $first", async ({ mode, first }) => {
    const second = new Error("cleanup failed");
    const operation = createDeferredCore();
    operation.reject(first);
    try {
      await settleWithCleanup(
        operation.promise,
        () => {
          throw second;
        },
        "both failed",
        mode,
      );
      expect.unreachable("both failures must be reported");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw error;
      }
      expect(error.message).toBe("both failed");
      expect(error.errors).toEqual([first, second]);
      expect(error.errors[0]).toBe(first);
      expect(error.errors[1]).toBe(second);
      expect(Object.hasOwn(error, "cause")).toBe(true);
      expect(error.cause).toBe(mode === "operation" ? first : second);
    }
  });
});

describe("throwIfSettledRejected", () => {
  it("accepts empty or successful work", () => {
    expect(() => throwIfSettledRejected([], "cleanup failed")).not.toThrow();
    expect(() =>
      throwIfSettledRejected([{ status: "fulfilled", value: undefined }], "cleanup failed"),
    ).not.toThrow();
  });

  it.each([new Error("cleanup failed"), "failure", undefined])(
    "preserves a single rejection reason: %s",
    (reason) => {
      let caught = false;
      try {
        throwIfSettledRejected([{ status: "rejected", reason }], "cleanup failed");
      } catch (error) {
        caught = true;
        expect(error).toBe(reason);
      }
      expect(caught).toBe(true);
    },
  );

  it("aggregates failures in input order with the caller's message", () => {
    const first = new Error("first");
    try {
      throwIfSettledRejected(
        [
          { status: "rejected", reason: first },
          { status: "fulfilled", value: "success" },
          { status: "rejected", reason: "second" },
        ],
        "Some cleanup failed",
      );
      expect.unreachable("multiple failures must be reported");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw error;
      }
      expect(error.message).toBe("Some cleanup failed");
      expect(error.errors).toEqual([first, "second"]);
      expect(error.errors[0]).toBe(first);
    }
  });
});

describe("throwSettledAggregate", () => {
  it("accepts empty or successful work", () => {
    expect(() => throwSettledAggregate([], "cleanup failed")).not.toThrow();
    expect(() =>
      throwSettledAggregate([{ status: "fulfilled", value: undefined }], "cleanup failed"),
    ).not.toThrow();
  });

  it("retains an aggregate envelope for a single non-Error rejection", () => {
    try {
      throwSettledAggregate([{ status: "rejected", reason: undefined }], "cleanup failed");
      expect.unreachable("the sole failure must be reported");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw error;
      }
      expect(error.message).toBe("cleanup failed");
      expect(error.errors).toEqual([undefined]);
      expect(Object.hasOwn(error, "cause")).toBe(false);
    }
  });

  it("preserves rejection identities and input order among successful work", () => {
    const first = new Error("first");
    try {
      throwSettledAggregate(
        [
          { status: "fulfilled", value: "success" },
          { status: "rejected", reason: first },
          { status: "rejected", reason: "second" },
        ],
        "joined cleanup failed",
      );
      expect.unreachable("the joined failures must be reported");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw error;
      }
      expect(error.message).toBe("joined cleanup failed");
      expect(error.errors).toEqual([first, "second"]);
      expect(error.errors[0]).toBe(first);
    }
  });
});
