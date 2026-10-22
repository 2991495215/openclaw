// Public embedded-agent bindings and persisted runtime ids.
import { describe, expect, it } from "vitest";
import { normalizeEmbeddedAgentRuntime } from "../agent-runtime-id.js";
import * as embeddedAgent from "../embedded-agent.js";
import { compactEmbeddedAgentSession } from "./compact.queued.js";
import { runEmbeddedAgent } from "./run.js";
import { abortEmbeddedAgentRun } from "./runs.js";

describe("embedded runner compatibility aliases", () => {
  it("keeps the embedded-agent barrel bound to the runner implementation", () => {
    // Shipped imports still reach the runner through the embedded-agent barrel;
    // keep these aliases exact so consumers do not fork stateful implementations.
    expect(embeddedAgent.runEmbeddedAgent).toBe(runEmbeddedAgent);
    expect(embeddedAgent.compactEmbeddedAgentSession).toBe(compactEmbeddedAgentSession);
    expect(embeddedAgent.abortEmbeddedAgentRun).toBe(abortEmbeddedAgentRun);
  });

  it("normalizes shipped runtime aliases", () => {
    // These aliases appear in persisted/runtime-facing config and must resolve
    // before model/provider dispatch observes the runtime id.
    expect(normalizeEmbeddedAgentRuntime("pi")).toBe("openclaw");
    expect(normalizeEmbeddedAgentRuntime("codex-app-server")).toBe("codex");
  });

  it("does not rewrite custom runtime ids", () => {
    expect(normalizeEmbeddedAgentRuntime("custom-harness")).toBe("custom-harness");
  });
});
