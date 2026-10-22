import { expect, it } from "vitest";
import { throwSqliteSettledErrors } from "./sqlite-lifecycle-errors.js";

it("accepts settled SQLite cleanup without failures", () => {
  expect(() => throwSqliteSettledErrors([], "cleanup")).not.toThrow();
  expect(() =>
    throwSqliteSettledErrors([{ status: "fulfilled", value: undefined }], "cleanup"),
  ).not.toThrow();
});

it.each([new Error("cleanup failed"), undefined])(
  "throws a single SQLite cleanup rejection unchanged: %s",
  (reason) => {
    let caught: unknown = "not thrown";
    try {
      throwSqliteSettledErrors(
        [
          { status: "fulfilled", value: 1 },
          { status: "rejected", reason },
        ],
        "cleanup",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  },
);

it("retains ordered cleanup failures and the first failure as their cause", () => {
  const first = new Error("first");
  const second = new Error("second");
  let caught: unknown;
  try {
    throwSqliteSettledErrors(
      [
        { status: "rejected", reason: first },
        { status: "fulfilled", value: "done" },
        { status: "rejected", reason: second },
      ],
      "cleanup failed",
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  if (!(caught instanceof AggregateError)) {
    throw new Error("Expected aggregate cleanup failure");
  }
  expect(caught.message).toBe("cleanup failed");
  expect(caught.errors).toEqual([first, second]);
  expect(caught.cause).toBe(first);
});
