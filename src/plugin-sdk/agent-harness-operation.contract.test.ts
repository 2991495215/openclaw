import { describe, expectTypeOf, it } from "vitest";
import type { AgentHarnessAttemptParams } from "./agent-harness-runtime.js";

type HarnessOperation = NonNullable<AgentHarnessAttemptParams["replyOperation"]>;

// A third-party consumer handles the published alternatives exhaustively.
function describeResult(result: NonNullable<HarnessOperation["result"]>): string {
  switch (result.kind) {
    case "completed":
      return "completed";
    case "failed":
    case "aborted":
      return result.code;
    default:
      return result satisfies never;
  }
}

describe("harness operation observations", () => {
  it("exposes the canonical phase, result, and turn-kind alternatives", () => {
    expectTypeOf<HarnessOperation["phase"]>().toEqualTypeOf<
      | "queued"
      | "waiting_for_deferred_maintenance"
      | "waiting_for_global_lane"
      | "preflight_compacting"
      | "memory_flushing"
      | "running"
      | "completed"
      | "failed"
      | "aborted"
    >();
    expectTypeOf<HarnessOperation["turnKind"]>().toEqualTypeOf<
      "visible" | "background" | "queued_followup"
    >();
    expectTypeOf<ReturnType<typeof describeResult>>().toEqualTypeOf<string>();
  });
});
