import { expect, it } from "vitest";
import { createObjectIdAllocator } from "./object-id.js";

it("keeps object IDs stable and each allocator independent", () => {
  const zero = createObjectIdAllocator();
  const one = createObjectIdAllocator(1);
  const first = {};
  const second = {};

  expect([zero(first), zero(first), zero(second), one(second), one(first), one(second)]).toEqual([
    0, 0, 1, 1, 2, 1,
  ]);
});
