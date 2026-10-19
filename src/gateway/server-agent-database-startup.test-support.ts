import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";

export function pauseIntegrityInspection(params: {
  root: string;
  pathname: string;
  pausePreparation?: boolean;
  pauseSchema?: boolean;
  preparationReceiptBroadcastName?: string;
}) {
  const releasePath = path.join(params.root, "release-inspection");
  const enteredPath = path.join(params.root, "inspection-entered");
  const preparationReleasePath = `${releasePath}-preparation`;
  const preparationEnteredPath = `${enteredPath}-preparation`;
  const preload = path.join(params.root, "pause-inspection.cjs");
  fs.writeFileSync(
    preload,
    `
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { BroadcastChannel, isMainThread, threadId } = require('node:worker_threads');
const receiptBroadcastName = ${JSON.stringify(params.preparationReceiptBroadcastName)};
const receipts = !isMainThread && receiptBroadcastName ? new BroadcastChannel(receiptBroadcastName) : undefined;
receipts?.unref();
const pathname = ${JSON.stringify(fs.realpathSync.native(params.pathname))};
const preparation = ${params.pausePreparation === true} && (!isMainThread || process.argv[1]?.includes('sqlite-integrity.worker'));
const marker = preparation ? ${JSON.stringify(preparationEnteredPath)} : ${JSON.stringify(enteredPath)};
const release = preparation ? ${JSON.stringify(preparationReleasePath)} : ${JSON.stringify(releasePath)};
let startupInspection = false;
// A preload listener starts IPC delivery before the worker registers its handler.
const emit = process.emit;
process.emit = function(event, ...args) {
  if (event === 'message') {
    const request = args[0];
    startupInspection = request?.type === 'inspect' && request.input?.requireStartupMigrationReadiness === true;
  }
  return emit.call(this, event, ...args);
};
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const location = this.location();
  const selected = ${params.pauseSchema === true} && !preparation ? startupInspection && /PRAGMA user_version/i.test(sql) : /integrity_check/.test(sql);
  if (selected && location && fs.realpathSync.native(location) === pathname) {
    // Existence is the shutdown gate; never expose a truncated PID.
    const pendingMarker = marker + '.' + process.pid + '.tmp';
    if (!isMainThread) fs.writeFileSync(marker + '.thread', String(threadId));
    fs.writeFileSync(pendingMarker, String(process.pid));
    fs.renameSync(pendingMarker, marker);
    receipts?.postMessage({ source: marker, line: 'entered' });
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(release)) {
      if (Date.now() > deadline) throw new Error('inspection fixture pause expired');
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  return prepare.call(this, sql);
};
`,
  );
  const env = sqliteWorkerPreloadEnv(preload);
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return {
    env,
    releasePath,
    enteredPath,
    preparationReleasePath,
    preparationEnteredPath,
  };
}
