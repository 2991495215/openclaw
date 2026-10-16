import fs from "node:fs";
import path from "node:path";
import { createDedupeCache } from "../infra/dedupe.js";
import { hasErrnoCode } from "../infra/errno.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { sleep } from "../utils/sleep.js";
import {
  resolveConfigIoEffect,
  runConfigIoAsync,
  runConfigIoSync,
  type ConfigIoOperation,
} from "./io.effects.js";
import { formatConfigArtifactTimestamp } from "./io.write-safety.js";

const CONFIG_CLOBBER_SNAPSHOT_LIMIT = 32;

const CONFIG_CLOBBER_LOCK_STALE_MS = 30_000;
const CONFIG_CLOBBER_LOCK_RETRY_MS = 10;
const CONFIG_CLOBBER_LOCK_TIMEOUT_MS = 2_000;
// Queue local writes first so filesystem-lock timeouts cover other processes, not sibling tasks.
const clobberSnapshotQueue = new KeyedAsyncQueue();
const clobberCapWarnedPaths = createDedupeCache({
  ttlMs: 0,
  maxSize: 4096,
});

type ConfigClobberSnapshotDeps = {
  logger: Pick<typeof console, "warn">;
};

function isFsErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && hasErrnoCode(error, code);
}

function resolveClobberPaths(configPath: string): {
  dir: string;
  prefix: string;
  lockPath: string;
} {
  const dir = path.dirname(configPath);
  const basename = path.basename(configPath);
  return {
    dir,
    prefix: `${basename}.clobbered.`,
    lockPath: path.join(dir, `${basename}.clobber.lock`),
  };
}

function shouldRemoveStaleLock(mtimeMs: number | undefined, nowMs: number): boolean {
  return typeof mtimeMs === "number" && nowMs - mtimeMs > CONFIG_CLOBBER_LOCK_STALE_MS;
}

async function acquireClobberLock(lockPath: string): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CONFIG_CLOBBER_LOCK_TIMEOUT_MS) {
    try {
      await fs.promises.mkdir(lockPath, { mode: 0o700 });
      return true;
    } catch (error) {
      if (!isFsErrorCode(error, "EEXIST")) {
        return false;
      }
      const stat = await fs.promises.stat(lockPath).catch(() => null);
      if (shouldRemoveStaleLock(stat?.mtimeMs, Date.now())) {
        await fs.promises.rmdir(lockPath).catch(() => {});
        continue;
      }
      await sleep(CONFIG_CLOBBER_LOCK_RETRY_MS);
    }
  }
  return false;
}

function acquireClobberLockSync(lockPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      return true;
    } catch (error) {
      if (!isFsErrorCode(error, "EEXIST")) {
        return false;
      }
      const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
      if (!shouldRemoveStaleLock(stat?.mtimeMs, Date.now())) {
        return false;
      }
      try {
        fs.rmdirSync(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

type ClobberedSiblingSnapshot = {
  name: string;
  path: string;
  timestampKey: string;
  mtimeMs: number;
};

function* listClobberedSiblings(
  dir: string,
  prefix: string,
): ConfigIoOperation<ClobberedSiblingSnapshot[]> {
  try {
    const entries = yield* resolveConfigIoEffect({
      sync: () => fs.readdirSync(dir),
      async: () => fs.promises.readdir(dir),
    });
    const snapshots: ClobberedSiblingSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const pathname = path.join(dir, entry);
      const stat = yield* resolveConfigIoEffect({
        sync: () => fs.statSync(pathname, { throwIfNoEntry: false }) ?? null,
        async: () => fs.promises.stat(pathname).catch(() => null),
      });
      snapshots.push({
        name: entry,
        path: pathname,
        timestampKey: entry.slice(prefix.length).replace(/-\d{2}$/, ""),
        mtimeMs: stat?.mtimeMs ?? 0,
      });
    }
    return snapshots.toSorted(
      (left, right) =>
        left.timestampKey.localeCompare(right.timestampKey) ||
        left.mtimeMs - right.mtimeMs ||
        left.name.localeCompare(right.name),
    );
  } catch {
    return [];
  }
}

type ClobberedConfigSnapshotParams = {
  deps: ConfigClobberSnapshotDeps;
  configPath: string;
  raw: string;
  observedAt: string;
};

function* persistClobberedConfigSnapshot(
  params: ClobberedConfigSnapshotParams,
  paths: ReturnType<typeof resolveClobberPaths>,
): ConfigIoOperation<string | null> {
  const { deps } = params;
  const existing = yield* listClobberedSiblings(paths.dir, paths.prefix);
  if (existing.length >= CONFIG_CLOBBER_SNAPSHOT_LIMIT) {
    if (!clobberCapWarnedPaths.check(params.configPath)) {
      deps.logger.warn(
        `Config clobber snapshot cap reached for ${params.configPath}: ${existing.length} existing .clobbered.* files; rotating oldest snapshots to preserve the latest forensic copy.`,
      );
    }
    const deleteCount = existing.length - CONFIG_CLOBBER_SNAPSHOT_LIMIT + 1;
    for (const snapshot of existing.slice(0, deleteCount)) {
      try {
        yield* resolveConfigIoEffect({
          sync: () => fs.unlinkSync(snapshot.path),
          async: () => fs.promises.unlink(snapshot.path),
        });
      } catch (error) {
        if (!isFsErrorCode(error, "ENOENT")) {
          return null;
        }
      }
    }
  }
  const basePath = `${params.configPath}.clobbered.${formatConfigArtifactTimestamp(params.observedAt)}`;
  for (let attempt = 0; attempt < CONFIG_CLOBBER_SNAPSHOT_LIMIT; attempt++) {
    const targetPath = attempt === 0 ? basePath : `${basePath}-${String(attempt).padStart(2, "0")}`;
    const options = { encoding: "utf-8" as const, mode: 0o600, flag: "wx" };
    try {
      yield* resolveConfigIoEffect({
        sync: () => fs.writeFileSync(targetPath, params.raw, options),
        async: () => fs.promises.writeFile(targetPath, params.raw, options),
      });
      return targetPath;
    } catch (error) {
      if (!isFsErrorCode(error, "EEXIST")) {
        return null;
      }
    }
  }
  return null;
}

export async function persistBoundedClobberedConfigSnapshot(
  params: ClobberedConfigSnapshotParams,
): Promise<string | null> {
  const paths = resolveClobberPaths(params.configPath);
  return await clobberSnapshotQueue.enqueue(paths.lockPath, async () => {
    if (!(await acquireClobberLock(paths.lockPath))) {
      return null;
    }
    try {
      return await runConfigIoAsync(persistClobberedConfigSnapshot(params, paths));
    } finally {
      await fs.promises.rmdir(paths.lockPath).catch(() => {});
    }
  });
}

export function persistBoundedClobberedConfigSnapshotSync(
  params: ClobberedConfigSnapshotParams,
): string | null {
  const paths = resolveClobberPaths(params.configPath);
  if (!acquireClobberLockSync(paths.lockPath)) {
    return null;
  }
  try {
    return runConfigIoSync(persistClobberedConfigSnapshot(params, paths));
  } finally {
    try {
      fs.rmdirSync(paths.lockPath);
    } catch {}
  }
}
