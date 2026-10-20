import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";

/** Stop admissions on failure, but settle every admitted filesystem operation before cleanup. */
export async function runUpdateCandidatePluginTasks<T>(
  tasks: Array<() => Promise<T>>,
): Promise<T[]> {
  const result = await runTasksWithConcurrency({ tasks, limit: 4, errorMode: "stop" });
  if (result.hasError) {
    throw result.firstError;
  }
  return result.results;
}

export async function createUpdateCandidatePluginPool<Input, Output>() {
  const [{ WorkerTaskPool }, { resolveRuntimeProcessEntrypointUrl }] = await Promise.all([
    import("./worker-task-pool.js"),
    import("./runtime-process-url.js"),
  ]);
  return new WorkerTaskPool<Input, Output>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("updateCandidateState"),
    workerClass: "compute",
    maxPendingTasks: 4,
    restartOnError: false,
  });
}
