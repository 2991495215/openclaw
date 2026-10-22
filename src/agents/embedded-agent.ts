// Public embedded-agent barrel. Re-export the runner API used by gateway,
// command, and plugin surfaces without exposing internal runner file layout.
export type {
  EmbeddedAgentCompactResult,
  EmbeddedAgentMeta,
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
} from "./embedded-agent-runner/types.js";
export { compactEmbeddedAgentSession } from "./embedded-agent-runner/compact.queued.js";
export { runEmbeddedAgent } from "./embedded-agent-runner/run.js";
export {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
} from "./embedded-agent-runner/runs.js";
