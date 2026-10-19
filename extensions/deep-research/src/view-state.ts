import type { ResearchExecution } from "./execution.js";
import type { ResearchJob, ResearchState } from "./job-state.js";

/** Pure local reads; never recover jobs or poll providers. Caller assertions remain live. */
export async function listResearchJobs(state: ResearchState, context: ResearchExecution) {
  const entries = await state.open<ResearchJob>("jobs", context).entries();
  context.assertInvocationCurrent();
  return entries
    .map((entry) => entry.value)
    .filter(
      (job) =>
        job.sessionKey === context.sessionKey &&
        job.sessionId === context.sessionId &&
        job.agentId === context.agentId,
    )
    .toSorted((a, b) => b.createdAt - a.createdAt);
}
/** Pure local read. Recovery and provider polling belong to the service. */
export async function readResearchJob(
  state: ResearchState,
  id: string,
  context: ResearchExecution,
) {
  const job = await state.open<ResearchJob>("jobs", context).lookup(id);
  context.assertInvocationCurrent();
  if (
    !job ||
    job.sessionKey !== context.sessionKey ||
    job.sessionId !== context.sessionId ||
    job.agentId !== context.agentId
  ) {
    throw new Error("Research job not found in this conversation generation.");
  }
  const cancelled = await state.open<boolean>("cancellations", context).lookup(id);
  context.assertInvocationCurrent();
  return cancelled ? { ...job, cancelRequested: true } : job;
}
