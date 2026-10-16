import fs from "node:fs";
import { hasErrnoCode } from "../infra/errno.js";
import type { captureConfigAuditAppender } from "./io.audit.js";
import type { captureConfigHealthStateStore } from "./io.health-state.js";

export type ConfigRecoveryEffect<T> = {
  sync: () => T;
  async: (
    health: ReturnType<typeof captureConfigHealthStateStore>,
    appendAudit: ReturnType<typeof captureConfigAuditAppender>,
  ) => T | Promise<T>;
};

export async function commitRecoveryFileIfCurrent(params: {
  health: ReturnType<typeof captureConfigHealthStateStore>;
  beforeCommit?: () => void;
  write: (assertCurrent: () => void) => Promise<unknown>;
}): Promise<boolean> {
  let superseded: Error | undefined;
  try {
    await params.write(() => {
      params.beforeCommit?.();
      if (!params.health.isCurrent()) {
        superseded = new Error("Config recovery observation was superseded");
        throw superseded;
      }
    });
    return true;
  } catch (error) {
    if (superseded && error === superseded) {
      return false;
    }
    throw error;
  }
}

export function createConfigRecoveryStatEffect(
  configPath: string,
  requireIdentity = false,
): ConfigRecoveryEffect<fs.Stats | null> {
  const unavailable = (error: unknown): null => {
    if (requireIdentity && !hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return null;
  };
  return {
    sync: () => {
      try {
        return fs.statSync(configPath, { throwIfNoEntry: false }) ?? null;
      } catch (error) {
        return unavailable(error);
      }
    },
    async: () => fs.promises.stat(configPath).catch(unavailable),
  };
}

export function createConfigBackupMissingEffect(backupPath: string): ConfigRecoveryEffect<boolean> {
  return {
    sync: () => {
      try {
        fs.statSync(backupPath);
        return false;
      } catch (error) {
        return hasErrnoCode(error, "ENOENT");
      }
    },
    async: () =>
      fs.promises.stat(backupPath).then(
        () => false,
        (error: unknown) => hasErrnoCode(error, "ENOENT"),
      ),
  };
}

export function createConfigBackupReadEffect(
  backupPath: string,
): ConfigRecoveryEffect<string | null> {
  const unavailable = (error: unknown): null => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return null;
  };
  return {
    sync: () => {
      try {
        return fs.readFileSync(backupPath, "utf-8");
      } catch (error) {
        return unavailable(error);
      }
    },
    async: () => fs.promises.readFile(backupPath, "utf-8").catch(unavailable),
  };
}
