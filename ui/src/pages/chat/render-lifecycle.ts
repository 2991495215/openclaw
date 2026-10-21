type CancelAfterCommit = () => void;
export type AfterCommitEffect = (complete: () => void) => CancelAfterCommit | void;

/** Renderer-neutral boundary for imperative renderers and DOM-dependent effects. */
export interface RenderLifecycle {
  invalidate(): void;
  /**
   * Run after pending DOM work settles. Async follow-up work returns its cleanup and
   * calls `complete` when done so the lifecycle owns it through teardown.
   */
  afterCommit(effect: AfterCommitEffect, onCancel?: () => void): CancelAfterCommit;
}

// Opt-in E2E instrumentation. Renderers report accepted invalidations and
// completed DOM commits here; counters and retained references belong to the test.
export function notifyRenderLifecycleForTest(host: object, phase: "invalidate" | "commit"): void {
  // SAFETY: The E2E probe installs this optional property using the shared hook type.
  const scope = globalThis as typeof globalThis & {
    openclawRenderLifecycleTestHook?: typeof notifyRenderLifecycleForTest;
  };
  scope.openclawRenderLifecycleTestHook?.(host, phase);
}

export type AfterCommitTask = {
  started: boolean;
  run(this: void): void;
  cancel(this: void): void;
};

/** Shared settlement; schedulers retain scope, generation, and parking policy. */
export function createAfterCommitTask<T extends object>(
  tasks: Set<T & AfterCommitTask>,
  metadata: T,
  effect: AfterCommitEffect,
  options: { isCurrent: () => boolean; onCancel?: () => void; cleanupOnComplete?: boolean },
): T & AfterCommitTask {
  let cleanup: (() => void) | undefined;
  const complete = () => {
    if (!tasks.delete(task)) {
      return;
    }
    const release = cleanup;
    cleanup = undefined;
    if (options.cleanupOnComplete) {
      release?.();
    }
  };
  const task: T & AfterCommitTask = Object.assign(metadata, {
    started: false,
    run() {
      if (!tasks.has(task)) {
        return;
      }
      if (!options.isCurrent()) {
        task.cancel();
        return;
      }
      task.started = true;
      try {
        const nextCleanup = effect(complete);
        if (typeof nextCleanup === "function") {
          // Completion or retirement can occur inside the callback.
          if (tasks.has(task) && options.isCurrent()) {
            cleanup = nextCleanup;
          } else {
            nextCleanup();
          }
        } else {
          complete();
        }
      } catch (error) {
        complete();
        throw error;
      }
    },
    cancel() {
      if (!tasks.delete(task)) {
        return;
      }
      try {
        cleanup?.();
      } finally {
        cleanup = undefined;
        if (!task.started) {
          options.onCancel?.();
        }
      }
    },
  });
  tasks.add(task);
  return task;
}
