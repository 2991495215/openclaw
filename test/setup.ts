// Default test setup installs the shared test environment.
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";
import { sha256File } from "@openclaw/fs-safe/durability";
import { isSupported as isProcessIdentitySupported } from "@openclaw/proc-safe/identity";
import { afterAll, beforeAll, expect } from "vitest";
import { installSharedTestSetup } from "./setup.shared.js";

installSharedTestSetup();
// Select host bindings before platform fixtures can poison the dependencies' process caches.
await sha256File(fileURLToPath(import.meta.url));
isProcessIdentitySupported();

// Temporary diagnosis: identify the original five-file group without exposing home paths.
const diagnosticFiles = [
  "src/gateway/server-agent-database-startup.test.ts",
  "src/gateway/server-aux-methods.test.ts",
  "src/gateway/server-chat.agent-events.test.ts",
  "src/gateway/server-close.model-acquisition.test.ts",
  "src/gateway/server-run-shutdown.recovery.test.ts",
];
const diagnosticPath = expect.getState().testPath?.replaceAll("\\", "/");
const diagnosticFile = diagnosticFiles.find(
  (file) => diagnosticPath === file || diagnosticPath?.endsWith(`/${file}`),
);
if (diagnosticFile) {
  const stamp = (phase: "suite-start-hook" | "suite-end-hook") => {
    try {
      console.error(
        "[startup-http-worker]",
        JSON.stringify({
          phase,
          file: diagnosticFile,
          pid: process.pid,
          threadId,
          workerId: /^\d+$/.test(process.env.VITEST_WORKER_ID ?? "")
            ? Number(process.env.VITEST_WORKER_ID)
            : null,
          poolId: /^\d+$/.test(process.env.VITEST_POOL_ID ?? "")
            ? Number(process.env.VITEST_POOL_ID)
            : null,
          timeMs: Date.now(),
        }),
      );
    } catch {
      // Diagnostic output cannot replace a suite's original result.
    }
  };
  beforeAll(() => stamp("suite-start-hook"));
  // This hook marks ordering only; other teardown hooks may still own cleanup.
  afterAll(() => stamp("suite-end-hook"));
}
