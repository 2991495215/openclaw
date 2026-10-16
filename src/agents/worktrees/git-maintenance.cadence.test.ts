import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import { createWorktreeGitMaintenance } from "./git-maintenance.js";
import { requireGit } from "./git.js";
import * as registryReads from "./registry-read.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

const WORKTREE_GC_INTERVAL_MS = 60 * 60_000;
const fixtureEpoch = Date.now();
const env = process.env;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const initRepo = useManagedWorktreeTestRepository();
afterEach(() => vi.restoreAllMocks());

// Cadence belongs to the maintenance closure. Its registry transport is fixed here
// so the test clock never crosses a SQLite worker's real lease clock.
it("throttles each repository for an hour without delaying newly registered repositories", async () => {
  const repo = await initRepo(tempDirs.make("worktree-maintenance-cadence-"));
  const otherRepo = await initRepo(tempDirs.make("worktree-maintenance-new-repo-"));
  const record = (repoRoot: string): ManagedWorktreeRecord => ({
    id: repoRoot,
    name: "cadence",
    repoRoot,
    repoFingerprint: repoRoot,
    path: repoRoot,
    branch: "main",
    baseRef: "HEAD",
    ownerKind: "manual",
    createdAt: fixtureEpoch,
    lastActiveAt: fixtureEpoch,
  });
  const records = [record(repo), record(repo)];
  vi.spyOn(registryReads, "readRegistryWorktrees").mockImplementation(async () => records);
  let now = fixtureEpoch;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const commands = vi.spyOn(gitExec, "executeGitCommand");
  const maintained = () =>
    commands.mock.calls.flatMap(([cwd, args]) => (args[0] === "maintenance" ? [cwd] : []));
  const maintain = createWorktreeGitMaintenance(env);
  await maintain({});
  expect(maintained()).toEqual([repo]);
  commands.mockClear();
  now += WORKTREE_GC_INTERVAL_MS - 1;
  await maintain({});
  expect(maintained()).toEqual([]);
  records.push(record(otherRepo));
  await maintain({});
  expect(maintained()).toEqual([otherRepo]);
  commands.mockClear();
  now += 1;
  await maintain({});
  expect(maintained()).toEqual([repo]);
  commands.mockClear();
  await maintain({ retryDeferred: true });
  expect(new Set(maintained())).toEqual(new Set([repo, otherRepo]));
  commands.mockClear();
  await maintain({});
  expect(maintained()).toEqual([]);
});

it("maintains each shared repository and suspends failures until explicitly retried", async () => {
  const repo = await initRepo(tempDirs.make("worktree-gc-first-repo-"));
  const otherRepo = await initRepo(tempDirs.make("worktree-gc-second-repo-"));
  for (const repoRoot of [repo, otherRepo]) {
    await requireGit(repoRoot, ["repack", "-d"]);
  }
  const records: ManagedWorktreeRecord[] = [];
  for (const [index, repoRoot] of [repo, repo, otherRepo].entries()) {
    const name = `manual-${index}`;
    const worktreePath = path.join(repoRoot, name);
    await fs.mkdir(worktreePath);
    records.push({
      id: name,
      name,
      repoFingerprint: name,
      repoRoot,
      path: worktreePath,
      branch: `openclaw/${name}`,
      baseRef: "HEAD",
      ownerKind: "manual",
      createdAt: fixtureEpoch + 1,
      lastActiveAt: fixtureEpoch + 1,
    });
  }
  vi.spyOn(registryReads, "readRegistryWorktrees").mockResolvedValue(records);
  let now = fixtureEpoch + 3;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const maintain = createWorktreeGitMaintenance(env);
  const collect = async (params: Parameters<typeof maintain>[0]) => {
    const progress = new WorktreeGcProgress();
    await maintain({ ...params, progress });
    return progress.result;
  };
  const controller = new AbortController();
  const execute = gitExec.executeGitCommand;
  const maintenanceRoots: string[] = [];
  const repairRoots: string[] = [];
  const taskOrders: string[][] = [];
  let failPackRepair = false;
  const commands = vi
    .spyOn(gitExec, "executeGitCommand")
    .mockImplementation(async (cwd, args, options) => {
      if (args[0] === "multi-pack-index") {
        repairRoots.push(cwd);
        expect(options?.timeoutMs).toBe(30 * 60_000);
        if (failPackRepair && cwd === repo) {
          throw new Error("pack index unavailable");
        }
      }
      if (args[0] !== "maintenance") {
        return await execute(cwd, args, options);
      }
      taskOrders.push(args.filter((arg) => arg.startsWith("--task=")));
      expect(options).toMatchObject({
        killProcessTree: true,
        signal: controller.signal,
        timeoutMs: 30 * 60_000,
        beforeRun: expect.any(Function),
        env: expect.objectContaining({ GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" }),
      });
      options?.beforeRun?.();
      maintenanceRoots.push(cwd);
      return {
        stdout: "",
        stderr: cwd === repo ? "gc is already running" : "",
        code: cwd === repo ? 1 : 0,
        signal: null,
        killed: false,
        termination: "exit",
        timeoutMs: options?.timeoutMs ?? 120_000,
      };
    });
  const logs = createWarnLogCapture("worktree-gc-maintenance");
  try {
    const result = await collect({ signal: controller.signal });
    expect(result).toMatchObject({
      removed: [],
      outcome: "partial",
      issues: [expect.objectContaining({ stage: "git-maintenance", id: repo, outcome: "failed" })],
      issueCount: 1,
    });
    expect(maintenanceRoots.toSorted()).toEqual([repo, otherRepo].toSorted());
    expect(repairRoots.toSorted()).toEqual([repo, otherRepo].toSorted());
    // Git honors task order; graph traversal must not starve pack-index repair.
    expect(taskOrders).toEqual(
      [repo, otherRepo].map(() => ["--task=commit-graph", "--task=loose-objects"]),
    );
    const warning = await logs.findText("worktree Git maintenance");
    expect(warning).toContain("gc is already running");
    now += WORKTREE_GC_INTERVAL_MS;
    await collect({ signal: controller.signal });
    expect(maintenanceRoots).toHaveLength(3);
    expect(repairRoots).toHaveLength(4);
    expect(maintenanceRoots.at(-1)).toBe(otherRepo);
    failPackRepair = true;
    now += WORKTREE_GC_INTERVAL_MS;
    await collect({ signal: controller.signal });
    expect(repairRoots).toHaveLength(6);
    failPackRepair = false;
    now += WORKTREE_GC_INTERVAL_MS;
    await collect({ signal: controller.signal });
    expect(repairRoots).toHaveLength(7);
    expect(maintenanceRoots).toHaveLength(5);
    await collect({ signal: controller.signal, retryDeferred: true });
    expect(maintenanceRoots).toHaveLength(7);
    expect(repairRoots).toHaveLength(9);
    const calls = commands.mock.calls.length;
    controller.abort(new Error("cleanup cancelled"));
    await expect(collect({ signal: controller.signal })).rejects.toThrow("cleanup cancelled");
    expect(commands).toHaveBeenCalledTimes(calls);
  } finally {
    logs.cleanup();
  }
});
