import { expect, it } from "vitest";
import { resolveAgentMaxConcurrent } from "./agent-limits.js";

it("clamps invalid agent concurrency limits to at least one", () => {
  const config = { agents: { defaults: { maxConcurrent: 0 } } };
  expect(resolveAgentMaxConcurrent(config)).toBe(1);
});
