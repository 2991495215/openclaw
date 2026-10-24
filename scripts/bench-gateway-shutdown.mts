import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { stopChild } from "./lib/gateway-bench-child.js";
import { getFreePort } from "./lib/gateway-bench-probes.js";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  parseNonNegativeInt,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.js";

// Reuse --fixture across invocations to measure warm admission and custody takeover.
// SQL observation is supplied by the caller; this workload never opens a database.
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    fixture: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    observer: { type: "string" },
    profile: { type: "boolean", default: false },
    "settle-ms": { type: "string", default: "1000" },
  },
});
assert(
  values.out && values.fixture,
  "Usage: --out <new-directory> --fixture <synthetic-directory>",
);
const out = path.resolve(values.out);
const fixture = path.resolve(values.fixture);
const settleMs = parseNonNegativeInt(values["settle-ms"], 1000, "--settle-ms");
mkdirSync(path.dirname(out), { recursive: true });
mkdirSync(out);
mkdirSync(fixture, { recursive: true });
const port = await getFreePort();
const configPath = writeGatewayBenchConfig(
  fixture,
  { ...BASE_GATEWAY_BENCH_CONFIG, gateway: { ...BASE_GATEWAY_BENCH_CONFIG.gateway, port } },
  {},
);
const setPhase = (phase: string) => writeFileSync(path.join(out, "phase"), phase);
setPhase("01.boot");
const log = createWriteStream(path.join(out, "gateway.log"));
const child = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(
    path.resolve(values.entry),
    port,
    values.profile ? gatewayBenchCpuProfileArgs(out) : [],
  ),
  {
    env: {
      ...createGatewayBenchEnv(fixture, configPath, {
        caseEnv: { OPENCLAW_SKIP_CHANNELS: "1" },
      }),
      NODE_DISABLE_COMPILE_CACHE: "1",
      ...(values.observer
        ? {
            SQLMEASURE_OUT: out,
            NODE_OPTIONS: `--require=${path.resolve(values.observer)} --enable-source-maps`,
          }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.pipe(log);
child.stderr.pipe(log);
const closed = once(child, "close");
try {
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 180_000,
    isDone: () => child.exitCode !== null || child.signalCode !== null,
  });
  assert.equal(ready.status, 200, "Synthetic Gateway must become ready before shutdown");
  setPhase("02.warm");
  await delay(settleMs);
  setPhase("03.shutdown");
  child.kill("SIGTERM");
  const result = await Promise.race([
    closed,
    delay(120_000, undefined, { ref: false }).then(() => {
      throw new Error("Synthetic Gateway shutdown timed out");
    }),
  ]);
  assert.deepEqual(result, [0, null], "Synthetic Gateway must shut down cleanly");
  writeFileSync(
    path.join(out, "evidence.json"),
    JSON.stringify({
      ok: true,
      port,
      load: loadavg(),
      children: [{ name: "gateway", pid: child.pid }],
    }),
  );
  console.log(JSON.stringify({ ok: true, out, port }));
} finally {
  await stopChild(child, { teardownGraceMs: 10_000, killGraceMs: 2_000 });
  log.end();
}
