import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import {
  captureRetainedNativeWorkerSource,
  closeDefaultRetainedNativeWorkerSource,
} from "./worker-native-lifecycle.js";
import { createOwnedWorkerTaskPool, WorkerTaskPool } from "./worker-task-pool.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it.each(["public", "owned"] as const)(
  "starts %s workers from the retained generation and joins them before release",
  async (kind) => {
    const directory = directories.make("worker-pool-generation-");
    const original = path.join(directory, "worker.mjs");
    const retained = path.join(directory, "retained-worker.mjs");
    await fs.writeFile(
      original,
      `import { parentPort } from "node:worker_threads";
parentPort.on("message", (message) => {
  if (typeof message.taskId === "number") {
    parentPort.postMessage({ taskId: message.taskId, status: "ok", value: "retained" });
  }
});`,
    );
    const originalUrl = pathToFileURL(original);
    const retainedUrl = pathToFileURL(retained);
    let pool:
      | WorkerTaskPool<string, string>
      | ReturnType<typeof createOwnedWorkerTaskPool<string, string>>
      | undefined;
    let released = false;
    try {
      await withRuntimeWorkerGeneration(
        async (bind) => {
          await fs.rename(original, retained);
          bind((url) => (url.href === originalUrl.href ? retainedUrl : url));
          const options = { workerUrl: originalUrl, maxWorkers: 1, idleTimeoutMs: 0 };
          pool =
            kind === "public"
              ? new WorkerTaskPool<string, string>(options)
              : createOwnedWorkerTaskPool<string, string>(options);
          await expect(pool.run("source", {})).resolves.toBe("retained");
          expect(pool.getSnapshot().workers).toBe(1);
        },
        async () => {
          expect(pool?.getSnapshot().workers).toBe(0);
          released = true;
        },
      );
      expect(released).toBe(true);
      await expect(pool!.run("after release", {})).rejects.toThrow("worker task pool closed");
    } finally {
      await pool?.close();
    }
  },
);

it.each(["default", "explicit"] as const)(
  "joins %s native pools without retiring an explicit owner's sibling",
  async (kind) => {
    const retained = new URL("./worker-task-pool.test-support.ts", import.meta.url);
    const original = pathToFileURL(
      path.join(directories.make("native-pool-generation-"), "old.ts"),
    );
    const nativeSource = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
    const sibling = createOwnedWorkerTaskPool<PoolFixtureInput, PoolFixtureResult>(
      { workerUrl: retained, maxWorkers: 1, idleTimeoutMs: 0 },
      { retainedTransport: true, nativeSource },
    );
    let pool:
      | ReturnType<typeof createOwnedWorkerTaskPool<PoolFixtureInput, PoolFixtureResult>>
      | undefined;
    try {
      await sibling.run({ label: "before" }, {});
      await withRuntimeWorkerGeneration(
        async (bind) => {
          bind((url) => (url.href === original.href ? retained : url));
          const boundSource = captureRetainedNativeWorkerSource({
            runtimeGeneration: captureRuntimeWorkerSource(original).runtimeGeneration,
          });
          pool = createOwnedWorkerTaskPool<PoolFixtureInput, PoolFixtureResult>(
            { workerUrl: original, maxWorkers: 1, idleTimeoutMs: 0 },
            { retainedTransport: true, ...(kind === "explicit" ? { nativeSource } : {}) },
          );
          await expect(pool.run({ label: "retained" }, {})).resolves.toMatchObject({
            label: "retained",
          });
          expect(pool.getSnapshot().workers).toBe(1);
          if (kind === "default") {
            expect(boundSource.hasActiveWorkers).toBe(true);
          }
        },
        async () => {
          expect(pool!.getSnapshot().workers).toBe(0);
          await expect(sibling.run({ label: "still alive" }, {})).resolves.toMatchObject({
            label: "still alive",
          });
        },
      );
      await expect(pool!.run({ label: "late" }, {})).rejects.toThrow("worker task pool closed");
    } finally {
      await pool?.close();
      await sibling.close();
      await closeDefaultRetainedNativeWorkerSource();
    }
  },
);
