import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { probeGatewayMemorySearch } from "../../scripts/lib/gateway-bench-session-setup.ts";

const mocks = vi.hoisted(() => ({
  resources: vi.fn(),
  stop: vi.fn(),
  run: vi.fn(),
  profile: vi.fn(),
  result: { results: [] } as Record<string, unknown>,
}));
vi.mock("../../scripts/lib/gateway-bench-profile.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  readGatewayResources: mocks.resources,
  controlGatewayProfile: mocks.profile,
  startGatewayDiagnostics: async () => mocks.stop,
}));
vi.mock("../../scripts/lib/managed-child-process.mts", () => ({
  runManagedCommand: mocks.run,
}));

const params = {
  gateway: {} as ChildProcess,
  runtime: "node",
  entry: "/fixture/dist/entry.js",
  env: {},
  timeoutMs: 1000,
  onChild: vi.fn(),
};
const statsTask = {
  channel: "openclaw.worker.task",
  operation: "manager-index.worker.js",
  outcome: "ok",
  count: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.result = { results: [] };
  let sample = 0;
  mocks.resources.mockImplementation(async () => ({
    pid: 123,
    atMonotonicMicros: ++sample * 1000,
    process: { user: 0, system: 0 },
    mainThread: { user: 0, system: 0 },
    workers: {
      workerHeaps: [{ script: "/fixture/manager-index.worker.js", threadId: 8 }],
      workerMemoryMissing: [],
      workerLifecycle: [],
    },
  }));
  mocks.stop.mockResolvedValue({
    groups: [
      statsTask,
      ...["received", "response"].map((phase) => ({
        channel: "openclaw.gateway.rpc",
        operation: `memory.search.owner.${phase}`,
        outcome: "observed",
        count: 1,
      })),
    ],
    collectionErrors: 0,
    droppedEvents: 0,
  });
  mocks.profile.mockResolvedValue(undefined);
  mocks.run.mockImplementation(async ({ onReady }) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    onReady({ stdout, stderr });
    stdout.end(JSON.stringify(mocks.result));
    stderr.end();
    return 0;
  });
});

it("accepts an empty search only with successful Gateway indexing tasks and a retained index worker", async () => {
  await expect(probeGatewayMemorySearch(params)).resolves.toMatchObject({
    indexWorkerTaskCount: 1,
    resultCount: 0,
  });
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(params.onChild).toHaveBeenCalledOnce();
});

it.each([
  ["stale", { results: [], stale: true }],
  ["disabled", { status: "disabled" }],
])("rejects %s search results", async (_name, result) => {
  mocks.result = result;
  await expect(probeGatewayMemorySearch(params)).rejects.toThrow(
    "available, current search result",
  );
});

it("preserves an informational rebuild notice on current results", async () => {
  mocks.result = { results: [], warning: "Automatic repair requested" };
  await expect(probeGatewayMemorySearch(params)).resolves.toMatchObject({
    indexWorkerTaskCount: 1,
    warning: "Automatic repair requested",
  });
});

it.each([
  ["local fallback", []],
  ["local fallback with coincident indexing", [statsTask]],
  ["unrelated worker", [{ ...statsTask, operation: "memorySearch.search" }]],
  ["failed stats", [{ ...statsTask, outcome: "error" }]],
])("rejects successful CLI output backed by %s", async (_name, groups) => {
  mocks.stop.mockResolvedValue({ groups, collectionErrors: 0, droppedEvents: 0 });
  await expect(probeGatewayMemorySearch(params)).rejects.toThrow(
    "did not prove successful Gateway",
  );
});

it("rejects an index worker that retired before its resource sample", async () => {
  mocks.resources.mockResolvedValue({
    workers: { workerHeaps: [], workerMemoryMissing: [], workerLifecycle: [] },
  });
  await expect(probeGatewayMemorySearch(params)).rejects.toThrow("indexing worker is absent");
});

it("stops diagnostic capture when the CLI child fails", async () => {
  const error = new Error("child deadline exceeded");
  mocks.run.mockRejectedValue(error);
  await expect(probeGatewayMemorySearch(params)).rejects.toMatchObject({ errors: [error] });
  expect(mocks.stop).toHaveBeenCalledOnce();
});

it("preserves unsettled CLI cleanup when diagnostics also fail", async () => {
  const commandError = Object.assign(new Error("CLI cleanup failed"), {
    processTreeState: "indeterminate",
  });
  const diagnosticError = new Error("Gateway disconnected");
  mocks.run.mockRejectedValue(commandError);
  mocks.stop.mockRejectedValue(diagnosticError);
  await expect(probeGatewayMemorySearch(params)).rejects.toMatchObject({
    errors: [commandError, diagnosticError],
  });
});

it("stops activation profiling and preserves both command and profile cleanup errors", async () => {
  const commandError = new Error("CLI failed");
  const profileError = new Error("profile cleanup failed");
  mocks.run.mockRejectedValue(commandError);
  mocks.profile.mockResolvedValueOnce(undefined).mockRejectedValueOnce(profileError);
  await expect(
    probeGatewayMemorySearch({ ...params, cpuProfilePath: "/fixture/activation.cpuprofile" }),
  ).rejects.toMatchObject({ errors: [commandError, profileError] });
  expect(mocks.profile).toHaveBeenCalledTimes(2);
  expect(mocks.stop).toHaveBeenCalledOnce();
});

it.each(["replacement", "retirement"])(
  "rejects index worker %s during activation",
  async (kind) => {
    let sample = 0;
    mocks.resources.mockImplementation(async () => ({
      workers: {
        workerHeaps: [
          { script: "manager-index.worker.js", threadId: kind === "replacement" ? ++sample : 8 },
        ],
        workerMemoryMissing: [],
        workerLifecycle: [
          {
            script: "manager-index.worker.js",
            retired: [{ reason: "idle", count: kind === "retirement" ? ++sample : 0 }],
          },
        ],
      },
    }));
    await expect(probeGatewayMemorySearch(params)).rejects.toThrow("retired or changed");
  },
);
