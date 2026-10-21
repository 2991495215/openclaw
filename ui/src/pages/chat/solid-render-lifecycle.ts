import { createEffect, createSignal, onCleanup, type Accessor } from "@solidjs/signals";
import { createParkedProjection } from "../../lib/reactive/parked-projection.ts";
import {
  type AfterCommitEffect,
  type AfterCommitTask,
  createAfterCommitTask,
  notifyRenderLifecycleForTest,
  type RenderLifecycle,
} from "./render-lifecycle.ts";

export type SolidRenderLifecycle<T> = RenderLifecycle & {
  readonly snapshot: Accessor<T>;
};

type CommitTask = AfterCommitTask & { generation: number };

/** Create inside the pane's Solid owner. Domain state and frame coalescing stay with their owners. */
export function createSolidRenderLifecycle<T>(options: {
  host: object;
  presented: () => boolean;
  read: () => T;
}): SolidRenderLifecycle<T> {
  let disposed = false;
  let requestedGeneration = 0;
  let committedRequest = -1;
  const tasks = new Set<CommitTask>();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const frame = createParkedProjection(
    () => ({ generation: revision(), value: options.read() }),
    options.presented,
  );

  const invalidate = () => {
    if (disposed) {
      return;
    }
    requestedGeneration += 1;
    setRevision(requestedGeneration);
    // Telemetry follows committed visibility without subscribing the invalidating caller.
    if (committedRequest >= 0) {
      notifyRenderLifecycleForTest(options.host, "invalidate");
    }
  };

  const enqueue = (effect: AfterCommitEffect, onCancel?: () => void): (() => void) => {
    if (disposed) {
      onCancel?.();
      return () => {};
    }
    const task = createAfterCommitTask(tasks, { generation: requestedGeneration + 1 }, effect, {
      isCurrent: () => !disposed,
      onCancel,
      cleanupOnComplete: true,
    });
    invalidate();
    return task.cancel;
  };

  const runTasks = () => {
    for (const task of Array.from(tasks)) {
      // Recheck after each callback: one callback can park the pane before the next runs.
      if (disposed || !options.presented()) {
        break;
      }
      if (!task.started && task.generation <= committedRequest) {
        task.run();
      }
    }
  };
  onCleanup(() => {
    disposed = true;
    for (const task of Array.from(tasks)) {
      task.cancel();
    }
  });
  // The committed DOM gates imperative layout work and its cancellation on parking.
  createEffect(
    () => ({ frame: frame(), presented: options.presented() }),
    (next) => {
      if (!next.presented) {
        committedRequest = -1;
        // Pending work waits for reveal; already-started foreground work retires.
        for (const task of Array.from(tasks)) {
          if (task.started) {
            task.cancel();
          }
        }
        return;
      }
      committedRequest = next.frame.generation;
      notifyRenderLifecycleForTest(options.host, "commit");
      runTasks();
    },
  );

  return {
    snapshot: () => frame().value,
    invalidate,
    afterCommit: enqueue,
  };
}
