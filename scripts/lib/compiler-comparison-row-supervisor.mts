// Trusted PID1 holds both host-observed barriers; it never launches another row.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";
import { setTimeout } from "node:timers/promises";

assert.equal(process.pid, 1, "Row supervisor must own the container lifetime");
assert.equal(process.versions.node, "24.16.0");
const command: unknown = JSON.parse(process.argv[2] ?? "null");
assert(
  Array.isArray(command) && command.length > 0 && command.every((arg) => typeof arg === "string"),
);
for (const directory of ["tsgo-cache", "row-metrics", "dist-artifacts.lock"]) {
  fs.mkdirSync(`/work/.artifacts/${directory}`);
}
const waitForHost = async (name: string) => {
  while (!fs.existsSync(`/row-control/${name}`)) {
    await setTimeout(25);
  }
  assert.equal(fs.readFileSync(`/row-control/${name}`, "utf8"), name);
};
console.log("[compiler-row:ready]");
await waitForHost("start");
const startedAt = new Date().toISOString();
const child = spawn(command[0], command.slice(1), {
  cwd: "/work",
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
});
const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
  (resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  },
);
const exitCode = result.code ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
console.log(
  `[compiler-row:finish] ${JSON.stringify({ ...result, exitCode, startedAt, finishedAt: new Date().toISOString() })}`,
);
// Only this waiting supervisor may remain at the frozen final census. A child
// that escaped the wrapper's group is rejected by the host before release.
await waitForHost("release");
process.exitCode = exitCode;
