// Fresh processes per mode; timing must run without --trace-gc* or allocation sampling.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapSpaceStatistics } from "node:v8";
import type { PairedDevice } from "../../src/infra/device-pairing.types.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    "state-dir": { type: "string" },
    output: { type: "string" },
    operations: { type: "string", default: "4000" },
    devices: { type: "string", default: "64" },
    warmup: { type: "string", default: "30" },
    "pace-ms": { type: "string", default: "1" },
    "ready-file": { type: "string" },
    "start-file": { type: "string" },
    "publication-source": { type: "string" },
    "gc-log": { type: "string" },
  },
});
const integer = (name: keyof typeof values, min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
assert(values["state-dir"] && values.output, "Supply --state-dir and --output");
const mode = values.mode;
assert(["prepare", "timing", "promotion", "allocation"].includes(mode));
const traced = process.execArgv.some((arg) => /^--trace[-_]gc/.test(arg));
assert.equal(traced, mode === "promotion", "Only promotion mode accepts --trace-gc flags");
if (mode === "promotion") {
  assert(global.gc && values["gc-log"], "Promotion requires --expose-gc and --gc-log");
}
if (mode !== "prepare") {
  assert(values["ready-file"] && values["start-file"], "Supply --ready-file and --start-file");
  assert(!existsSync(values["start-file"]), "Use a fresh start file for each pair");
}
const stateDir = path.resolve(values["state-dir"]);
process.env.OPENCLAW_STATE_DIR = stateDir;
const operations = integer("operations", 1);
const deviceCount = integer("devices", 1);
const warmup = integer("warmup", 1);
const paceMs = integer("pace-ms", 0);
const profilePath = path.resolve(`${values.output}.heapprofile`);
const marker = (phase: string) =>
  writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
  );
if (mode === "promotion") {
  // Identify the main isolate before workers exist; timing never forces a collection.
  marker("identify-start");
  global.gc!();
  marker("identify-stop");
}
const publicationUrl = new URL("../../src/infra/device-pairing-publication.ts", import.meta.url);
const publicationSource = values["publication-source"]
  ? path.resolve(values["publication-source"])
  : fileURLToPath(publicationUrl);
let substitutions = 0;
const hooks = values["publication-source"]
  ? registerHooks({
      resolve(specifier, context, nextResolve) {
        if (
          context.parentURL &&
          specifier.startsWith(".") &&
          new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL).href === publicationUrl.href
        ) {
          substitutions++;
          return nextResolve(pathToFileURL(publicationSource).href, context);
        }
        return nextResolve(specifier, context);
      },
    })
  : undefined;
const [database, store, publication, reads] = await Promise.all([
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/infra/device-pairing-store.js"),
  import("../../src/infra/device-pairing-publication.js"),
  import("../../src/infra/device-pairing-store-readonly.js"),
]);
const devices: PairedDevice[] = Array.from({ length: deviceCount }, (_, index) => ({
  deviceId: `synthetic-node-${index}`,
  publicKey: `synthetic-public-key-${index}`,
  displayName: `Synthetic node ${index}`,
  platform: "linux",
  roles: ["node"],
  tokens: { node: { token: `synthetic-token-${index}`, role: "node", scopes: [], createdAtMs: 1 } },
  nodeSurface: {
    caps: ["canvas"],
    commands: ["system.run"],
    permissions: { screenRecording: true },
    bins: ["git", "node"],
    createdAtMs: 1,
    approvedAtMs: index + 1,
  },
  createdAtMs: 1,
  approvedAtMs: index + 1,
}));
const golden = devices.toReversed();
const fixtureHash = hash("sha256", JSON.stringify(golden));
const preparedPath = path.join(stateDir, "pairing-benchmark-fixture.json");
if (mode === "prepare") {
  mkdirSync(stateDir, { mode: 0o700 });
} else {
  assert.equal(JSON.parse(readFileSync(preparedPath, "utf8")).fixtureHash, fixtureHash);
}
const db = database.openOpenClawStateDatabase();
const inspector = new Session();
const loop = monitorEventLoopDelay({ resolution: 1 });
const collections: { kind: number; ms: number; at: number }[] = [];
const collect = (entries: readonly { startTime: number; duration: number; detail?: unknown }[]) => {
  for (const entry of entries) {
    const detail = entry.detail as { kind: number };
    collections.push({ kind: detail.kind, ms: entry.duration, at: entry.startTime });
  }
};
const observer = new PerformanceObserver((list) => collect(list.getEntries()));
const distribution = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
    maxMs: sorted.at(-1) ?? 0,
    p95: { samples: sorted.length, ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null },
    p99: { samples: sorted.length, ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null },
  };
};
async function run(count: number, latencies?: number[]) {
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    publication.invalidateDevicePairingNodeSnapshot(db.path);
    const snapshot = await reads.readDevicePairingNodeSnapshot(stateDir);
    latencies?.push(performance.now() - started);
    assert.equal(snapshot.paired.length, deviceCount);
    assert.equal(snapshot.bindings.size, deviceCount);
    await delay(paceMs);
  }
}
try {
  if (mode === "prepare") {
    store.persistDevicePairingStoreState(
      {
        pendingById: {},
        pairedByDeviceId: Object.fromEntries(devices.map((device) => [device.deviceId, device])),
      },
      stateDir,
      "both",
    );
    writeFileSync(preparedPath, JSON.stringify({ fixtureHash, deviceCount }));
    writeFileSync(values.output, JSON.stringify({ mode, fixtureHash, deviceCount }));
  } else {
    const first = await reads.readDevicePairingNodeSnapshot(stateDir);
    assert(!values["publication-source"] || substitutions > 0, "Publication override must load");
    assert.deepEqual(first.paired, golden);
    assert(Object.isFrozen(first.paired[0]!.tokens!.node!.scopes));
    assert.equal(await reads.readDevicePairingNodeSnapshot(stateDir), first);
    await run(warmup);
    if (mode === "allocation") {
      inspector.connect();
    }
    const ready = { pid: process.pid, atEpochMs: Date.now(), processAgeSeconds: process.uptime() };
    writeFileSync(values["ready-file"]!, JSON.stringify(ready));
    while (!existsSync(values["start-file"]!)) {
      await delay(10);
    }
    const startAt = parseStrictIntegerOption({
      raw: readFileSync(values["start-file"]!, "utf8").trim(),
      label: "start-file epoch",
      min: 1,
      fallback: 1,
    });
    assert(startAt > Date.now(), "Missed synchronized start deadline; discard the pair");
    await delay(startAt - Date.now());
    if (mode === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32_768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const latencies: number[] = [];
    const heapBefore = getHeapSpaceStatistics();
    const ageBefore = process.uptime();
    observer.observe({ entryTypes: ["gc"] });
    loop.enable();
    const cpu = process.threadCpuUsage();
    if (mode === "promotion") {
      marker("diagnostics-start");
    }
    const started = performance.now();
    await run(operations, latencies);
    const ended = performance.now();
    const usedCpu = process.threadCpuUsage(cpu);
    if (mode === "promotion") {
      marker("diagnostics-stop");
    }
    loop.disable();
    await nextTurn();
    collect(observer.takeRecords());
    observer.disconnect();
    const gc = (kind?: number) =>
      distribution(
        collections
          .filter(
            (entry) =>
              entry.at >= started &&
              entry.at < ended &&
              (kind === undefined || entry.kind === kind),
          )
          .map((entry) => entry.ms),
      );
    let allocation;
    if (mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      let totalBytes = 0;
      let inspectionBytes = 0;
      const visit = (node: HeapProfiler.SamplingHeapProfileNode, inspecting = false) => {
        const inside = inspecting || node.callFrame.functionName === "inspectPlainData";
        totalBytes += node.selfSize;
        if (inside) {
          inspectionBytes += node.selfSize;
        }
        node.children.forEach((child) => visit(child, inside));
      };
      visit(profile.head);
      writeFileSync(profilePath, JSON.stringify(profile));
      allocation = { totalBytes, bytesPerPublication: totalBytes / operations, inspectionBytes };
    }
    const promotion =
      mode === "promotion"
        ? readGatewayGcTrace(path.resolve(values["gc-log"]!), profilePath, "diagnostics")
        : undefined;
    const last = await reads.readDevicePairingNodeSnapshot(stateDir);
    assert.deepEqual(last.paired, golden);
    assert.notEqual(last, first);
    const result = {
      scope: "pairing reader/SQLite worker/publication misses; no Gateway RPC or model",
      mode,
      timingEligible: mode === "timing",
      node: process.version,
      sourceHash: hash("sha256", readFileSync(publicationSource)),
      substitutions,
      operations,
      deviceCount,
      warmup,
      paceMs,
      fixtureHash,
      ready,
      requestedStartEpochMs: startAt,
      actualStartEpochMs: performance.timeOrigin + started,
      processAgeSeconds: ageBefore,
      heapSpaces: { before: heapBefore, after: getHeapSpaceStatistics() },
      allocation,
      cpu: {
        totalMs: (usedCpu.user + usedCpu.system) / 1000,
        msPerPublication: (usedCpu.user + usedCpu.system) / 1000 / operations,
        elapsedMs: ended - started,
        latency: distribution(latencies),
      },
      gc: {
        total: gc(),
        msPerPublication: gc().totalMs / operations,
        minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
        major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
        incremental: gc(constants.NODE_PERFORMANCE_GC_INCREMENTAL),
        weakCallback: gc(constants.NODE_PERFORMANCE_GC_WEAKCB),
      },
      promotion: promotion
        ? { ...promotion, bytesPerPublication: promotion.promotedBytes / operations }
        : null,
      eventLoop: {
        samples: loop.count,
        maxMs: loop.max / 1e6,
        p95: { samples: loop.count, ms: loop.count ? loop.percentile(95) / 1e6 : null },
        p99: { samples: loop.count, ms: loop.count ? loop.percentile(99) / 1e6 : null },
      },
    };
    writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
  }
} finally {
  inspector.disconnect();
  observer.disconnect();
  loop.disable();
  await database.closeOpenClawStateDatabaseAsync();
  hooks?.deregister();
}
