import process from "node:process";
import { afterAll, beforeEach, onTestFinished } from "vitest";

const collections: Array<{ kind: string; value: WeakRef<{ readonly size: number }> }> = [];
let previousCase: string | undefined;

// Temporary diagnostic only. Weak references must not keep retired fixtures alive.
export function observeSidebarDiagnosticCollection(
  kind: string,
  value: { readonly size: number },
): void {
  collections.push({ kind, value: new WeakRef(value) });
}

function snapshot() {
  const fixtureCollections: Record<
    string,
    { reachable: number; nonempty: number; entries: number }
  > = {};
  for (const entry of collections) {
    const value = entry.value.deref();
    if (!value) {
      continue;
    }
    const counts = (fixtureCollections[entry.kind] ??= { reachable: 0, nonempty: 0, entries: 0 });
    counts.reachable += 1;
    counts.nonempty += Number(value.size > 0);
    counts.entries += value.size;
  }
  const activeResources: Record<string, number> = {};
  for (const resource of process.getActiveResourcesInfo()) {
    activeResources[resource] = (activeResources[resource] ?? 0) + 1;
  }
  const roots: unknown = Reflect.get(globalThis, Symbol.for("openclaw.testSolidRoots"));
  return {
    memory: process.memoryUsage(),
    activeResources,
    fixtureCollections,
    trackedSolidRoots: roots instanceof Set ? roots.size : null,
    bodyChildren: document.body.childElementCount,
    connectedSidebars: document.querySelectorAll("openclaw-app-sidebar").length,
  };
}

function record(value: object) {
  console.info("SIDEBAR_DIAGNOSTIC", JSON.stringify(value));
}

beforeEach(({ task }) => {
  // The previous case's onTestFinished disposals have all completed by this hook.
  record({ phase: previousCase ? "after-cleanup" : "initial", case: previousCase, ...snapshot() });
  const started = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  previousCase = task.name;
  onTestFinished(() => {
    record({
      phase: "finished",
      case: task.name,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
      processCpuMicros: process.cpuUsage(cpu),
      memory: process.memoryUsage(),
    });
  });
});

afterAll(() => {
  record({ phase: "after-cleanup", case: previousCase, ...snapshot() });
});
