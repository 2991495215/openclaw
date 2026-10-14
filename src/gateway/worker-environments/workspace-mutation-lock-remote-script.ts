export const REMOTE_WORKSPACE_MUTATION_LOCK_JS = String.raw`function removeTree(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    fs.chmodSync(target, 0o700);
    for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}
function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
const lockRoot = path.join(
  transactionRoot,
  ".openclaw-accepted-lock-" + workspaceKey,
);
const lockToken = crypto.randomBytes(16).toString("hex");
const lockOwner = {
  action,
  nonce,
  pid: lockOwnerPid,
  controllerPid: process.pid,
  token: lockToken,
};
const lockWait = new Int32Array(new SharedArrayBuffer(4));
const lockDeadlineMs = Date.now() + 9 * 60 * 1000;
let acquiredLock;
function encodeLockIdentity(identity) {
  return [
    identity.action,
    identity.nonce,
    identity.pid,
    identity.controllerPid,
    identity.token,
  ].join(".");
}
// Lock files are transient current-runtime state; unknown identity shapes fail closed.
function parseLockIdentity(parts) {
  if (parts.length !== 5) return null;
  const [entryAction, entryNonce, rawPid, rawControllerPid, token] = parts;
  const pid = Number(rawPid);
  const controllerPid = Number(rawControllerPid);
  if (
    !mutationActions.includes(entryAction) ||
    !/^[a-f0-9]{32}$/.test(entryNonce || "") ||
    !/^[1-9][0-9]*$/.test(rawPid || "") ||
    !Number.isSafeInteger(pid) ||
    !/^[1-9][0-9]*$/.test(rawControllerPid || "") ||
    !Number.isSafeInteger(controllerPid) ||
    (entryAction !== "receiver" && controllerPid !== pid) ||
    !/^[a-f0-9]{32}$/.test(token || "")
  ) {
    return null;
  }
  return { action: entryAction, nonce: entryNonce, pid, controllerPid, token };
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") return true;
    if (error && error.code === "ESRCH") return false;
    throw error;
  }
}
function lockIdentityIsAlive(identity) {
  if (identity.action === "receiver") {
    // Receiver descendants own mutation liveness; the wrapper owns acquire/release.
    // Reclaim is safe only after both the receiver group and wrapper are dead.
    return processIsAlive(identity.pid) ||
      processIsAlive(-identity.pid) ||
      processIsAlive(identity.controllerPid);
  }
  return processIsAlive(identity.pid);
}
function ownerEntryName(owner) {
  return "owner." + encodeLockIdentity(owner);
}
function parseLockEntry(name) {
  const parts = name.split(".");
  if (parts[0] === "owner" && parts.length === 6) {
    const owner = parseLockIdentity(parts.slice(1));
    return owner ? { owner } : null;
  }
  return null;
}
function readLock() {
  let directoryStats;
  let names;
  try {
    directoryStats = fs.lstatSync(lockRoot);
    names = fs.readdirSync(lockRoot);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("unsafe workspace mutation lock");
  }
  // A dead owner's entry is unlinked before removing the now-empty directory.
  // Atomic acquisition may replace that directory even if recovery was interrupted.
  if (names.length === 0) return null;
  if (names.length !== 1) throw new Error("invalid workspace mutation lock");
  const entry = parseLockEntry(names[0]);
  if (!entry) throw new Error("invalid workspace mutation lock owner");
  const entryPath = path.join(lockRoot, names[0]);
  try {
    const entryStats = fs.lstatSync(entryPath);
    if (entryStats.isSymbolicLink() || !entryStats.isFile()) {
      throw new Error("unsafe workspace mutation lock owner");
    }
    return { ...entry, name: names[0], entryPath, directoryStats, entryStats };
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}
function sameLock(left, right) {
  return (
    left.name === right.name &&
    sameInode(left.directoryStats, right.directoryStats) &&
    sameInode(left.entryStats, right.entryStats)
  );
}
function removeLockOwner(observed) {
  try {
    // The random owner filename cannot belong to a replacement. Remove only
    // that owner, then let rmdir or atomic acquisition retire the empty lock.
    fs.unlinkSync(observed.entryPath);
    fs.rmdirSync(lockRoot);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTEMPTY" || error.code === "EEXIST")) {
      return false;
    }
    throw error;
  }
  return true;
}
function acquireWorkspaceLock() {
  const candidate = lockRoot + "." + process.pid + "." + lockToken;
  const ownerName = ownerEntryName(lockOwner);
  fs.mkdirSync(candidate, { mode: 0o700 });
  fs.writeFileSync(path.join(candidate, ownerName), "", { flag: "wx", mode: 0o600 });
  let acquired = false;
  let waitMs = 10;
  try {
    while (Date.now() < lockDeadlineMs) {
      try {
        // The owner entry is complete before this atomic namespace operation,
        // so contenders never mistake an initializing live owner for stale.
        fs.renameSync(candidate, lockRoot);
        acquired = true;
        const observed = readLock();
        if (!observed || observed.name !== ownerName) {
          throw new Error("workspace mutation lock acquisition changed");
        }
        acquiredLock = observed;
        return;
      } catch (error) {
        if (!error || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) throw error;
      }
      const observed = readLock();
      if (!observed) {
        waitMs = 10;
        continue;
      }
      if (!lockIdentityIsAlive(observed.owner) && removeLockOwner(observed)) {
        continue;
      }
      Atomics.wait(lockWait, 0, 0, waitMs);
      waitMs = Math.min(waitMs * 2, 500);
    }
    throw new Error("timed out waiting for workspace mutation lock");
  } finally {
    if (!acquired) removeTree(candidate);
  }
}
function releaseWorkspaceLock() {
  const current = readLock();
  if (
    !current ||
    !acquiredLock ||
    !sameLock(current, acquiredLock)
  ) {
    throw new Error("workspace mutation lock ownership changed");
  }
  removeLockOwner(current);
}`;
