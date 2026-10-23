import { expect, it } from "vitest";
import { findLastFittingValue } from "./budget-fit.js";

it.each([0, 1, 4, 8])("includes the last fitting candidate at %s", (limit) => {
  const candidates = new Map<number, { size: number }>();
  const result = findLastFittingValue(
    8,
    (size) => {
      expect(candidates.has(size)).toBe(false);
      const candidate = { size };
      candidates.set(size, candidate);
      return candidate;
    },
    ({ size }) => size <= limit,
    undefined,
  );
  expect(result).toBe(candidates.get(limit));
  expect(result?.size).toBe(limit);
});

it("returns the caller's fallback when no candidate fits", () => {
  const fallback = { omitted: true };
  expect(
    findLastFittingValue(
      8,
      (size) => ({ size }),
      () => false,
      fallback,
    ),
  ).toBe(fallback);
});
