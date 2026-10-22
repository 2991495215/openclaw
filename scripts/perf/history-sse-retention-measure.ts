// Bounded baseline only; canonical offline fixture and bench GC/lifecycle owners.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { get, type IncomingMessage, type ClientRequest } from "node:http";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  readGatewayCpuUsage,
  measureGatewayCpuUsage,
  readGatewayResources,
} from "../lib/gateway-bench-profile.ts";
import { buildGatewayBenchChildArgs, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import {
  sampleHistoryNativeTree,
  type HistoryNativeLifetime,
} from "../lib/history-native-samples.ts";
import { HistorySseFrames, validateHistoryPage } from "../lib/history-sse-frames.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";
const { values } = parseArgs({
  options: {
    root: { type: "string", default: ".openclaw/tmp/i2-baseline" },
    entry: { type: "string", default: "dist/entry.js" },
    output: { type: "string" },
    seed: { type: "boolean" },
    scored: { type: "boolean" },
    "raw-wire": { type: "boolean" },
  },
});
const root = path.resolve(values.root);
const state = path.join(root, "fixture");
const port = 41926;
const profile = "team-shape-" + port;
const sessionKey = "agent:main:team-shape-session-0";
const count = 16384;
const output = path.resolve(values.output ?? path.join(root, "run"));
const entry = path.resolve(values.entry);
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const record = (name: string, value: unknown) =>
  writeFileSync(path.join(output, name + ".json"), JSON.stringify(value, null, 2) + "\n");
if (values.seed) {
  const options = parseTeamShapeOptions([
    "--state-dir",
    state,
    "--sessions",
    "1",
    "--runs",
    "0",
    "--approvals",
    "0",
    "--cron",
    "0",
    "--projects",
    "0",
    "--transcript-mib",
    "0",
    "--bounded-transcript-entries",
    String(count),
    "--port",
    String(port),
  ]);
  const { summary } = await generateTeamShapeFixture(options);
  // Canonical fixture disables cron and seeds no automations; legacy heartbeat config is retired.
  console.log(JSON.stringify(summary));
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  await drainGlobalSingletonLifecycleState();
} else {
  assert.equal(
    JSON.parse(readFileSync(path.join(state, "team-shape-summary.json"), "utf8"))
      .transcriptMessages,
    count,
  );
  mkdirSync(output);
  const env = createGatewayBenchEnv(path.join(state, "home"), path.join(state, "openclaw.json"), {
    startupTrace: false,
    caseEnv: {
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_PROFILE: profile,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-" + profile,
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw." + profile,
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (" + profile + ")",
      OPENCLAW_SKIP_CHANNELS: "1",
      TMPDIR: path.join(state, "tmp"),
      TMP: path.join(state, "tmp"),
      TEMP: path.join(state, "tmp"),
      XDG_CACHE_HOME: path.join(state, "home", ".cache"),
      // Let the compiled foreground Gateway own cache selection under our TMPDIR.
      // Starting Node with NODE_COMPILE_CACHE forces execve and loses benchmark IPC.
    },
  });
  let gateway: ChildProcess | undefined;
  let request: ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  let closing = false;
  let failure: Error | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const processLifetimes = new Map<number, HistoryNativeLifetime>();
  let nativePoll: ReturnType<typeof setInterval> | undefined;
  const stageResources: Record<string, Awaited<ReturnType<typeof readGatewayResources>>> = {};
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      closing = true;
      response?.destroy();
      request?.destroy();
      if (gateway) {
        const stopped = await stopChild(gateway, { teardownGraceMs: 10000, killGraceMs: 2000 });
        clearInterval(nativePoll);
        sampleNativeTree();
        record("native-lifetimes", {
          coverage:
            "100ms procfs observation; transient descendants between observations may be missed; no complete child CPU attribution",
          processes: [...processLifetimes.values()],
          survivingObservedPids: [...processLifetimes.keys()].filter((pid) =>
            existsSync("/proc/" + pid),
          ),
        });
        record("cleanup", {
          stopped,
          pid: gateway.pid,
          pidAbsent: !existsSync("/proc/" + gateway.pid),
          at: new Date().toISOString(),
        });
      }
    })());
  const watchdog = setTimeout(() => {
    failure = new Error("300s runtime budget exhausted");
    void cleanup();
  }, 300000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void cleanup().finally(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15)));
    });
  }
  const sampleNativeTree = (includeMemory = false) =>
    gateway?.pid ? sampleHistoryNativeTree(gateway.pid, processLifetimes, includeMemory) : [];

  function custody(stage: string) {
    assert(gateway?.pid);
    const pid = gateway.pid;
    const proc = "/proc/" + pid;
    const fd = readdirSync(proc + "/fd").flatMap((name) => {
      try {
        return [{ fd: name, target: readlinkSync(proc + "/fd/" + name) }];
      } catch {
        return [];
      }
    });
    const socketInodes = new Set(
      fd.flatMap(({ target }) => /^socket:\[(\d+)\]$/.exec(target)?.slice(1) ?? []),
    );
    const sockets = ["tcp", "tcp6"].flatMap((file) =>
      readFileSync(proc + "/net/" + file, "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((fields) => socketInodes.has(fields[9]!))
        .map((fields) => ({
          kind: file,
          local: fields[1],
          remote: fields[2],
          state: fields[3],
          txRxQueueHex: fields[4],
          inode: fields[9],
        })),
    );
    record("custody-" + stage, {
      pid,
      controllerPid: process.pid,
      exe: readlinkSync(proc + "/exe"),
      command: readFileSync(proc + "/cmdline", "utf8").split("\0"),
      status: readFileSync(proc + "/status", "utf8"),
      tasks: readdirSync(proc + "/task"),
      fd,
      sockets,
      at: new Date().toISOString(),
      nativeTree: sampleNativeTree(stage.endsWith("-post-gc")),
    });
  }
  function assertHealthy() {
    if (failure) {
      throw failure;
    }
  }
  async function snapshot(stage: string) {
    assert(gateway);
    assertHealthy();
    custody(stage);
    const snapshotPath = path.join(output, stage + ".heapsnapshot");
    const started = Date.now();
    const resources = await readGatewayResources(gateway, {
      collectGarbage: true,
      ...(values.scored ? {} : { snapshotPath }),
    });
    stageResources[stage] = resources;
    custody(stage + "-post-gc");
    record(stage, {
      resources,
      snapshotPath,
      durationMs: Date.now() - started,
      sha256: values.scored ? undefined : sha(readFileSync(snapshotPath)),
      at: new Date().toISOString(),
    });
    assertHealthy();
  }
  try {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
    const args = buildGatewayBenchChildArgs(entry, port, [
      "--max-old-space-size=4096",
      "--import",
      "./scripts/tsx.mjs",
      "--import",
      "./scripts/lib/gateway-bench-profile-preload.ts",
    ]);
    args.splice(args.indexOf(entry) + 1, 0, "--profile", profile);
    record("launch", {
      executable: process.execPath,
      executableSha256: sha(readFileSync(process.execPath)),
      args,
      cwd: process.cwd(),
      env,
      controllerPid: process.pid,
      at: new Date().toISOString(),
    });
    const log = createWriteStream(path.join(output, "gateway.log"));
    const launchedAt = performance.now();
    gateway = spawn(process.execPath, args, {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    nativePoll = setInterval(() => sampleNativeTree(), 100);
    gateway.on("error", (error) => {
      failure ??= error;
    });
    gateway.stdout?.pipe(log);
    gateway.stderr?.pipe(log);
    record("pid", { pid: gateway.pid, controllerPid: process.pid });
    const deadline = Date.now() + 120000;
    for (;;) {
      assertHealthy();
      if (gateway.exitCode !== null || gateway.signalCode !== null || Date.now() > deadline) {
        throw new Error("Gateway readiness failed; inspect gateway.log");
      }
      if (
        await fetch("http://127.0.0.1:" + port + "/readyz", {
          signal: AbortSignal.timeout(2000),
        }).then(
          (r) => r.ok,
          () => false,
        )
      ) {
        break;
      }
      await delay(250);
    }
    record("startup", { elapsedMs: performance.now() - launchedAt, load: loadavg() });
    await delay(3000);
    await snapshot("before");
    const operations: Array<{
      prefix: string;
      wire: unknown;
      cpu: ReturnType<typeof measureGatewayCpuUsage>;
      transferMaxGapMs: number;
      load: number[];
    }> = [];
    async function runStream(prefix: string) {
      assert(gateway);
      const serving = gateway;
      const cpuBefore = await readGatewayCpuUsage(gateway);
      const parser = new HistorySseFrames();
      let wireBytes = 0;
      let histories = 0;
      let keepalives = 0;
      let wireSummary: unknown;
      const wireHash = createHash("sha256");
      const url =
        "http://127.0.0.1:" + port + "/sessions/" + encodeURIComponent(sessionKey) + "/history";
      const opened = Date.now();
      const requestStarted = performance.now();
      let headersAt: number | undefined;
      let firstByteAt: number | undefined;
      let frameReceivedAt: number | undefined;
      let framedAt: number | undefined;
      let parsedAt: number | undefined;
      let validatedAt: number | undefined;
      let completedAt: number | undefined;
      let lastDataAt = performance.now();
      let transferMaxGapMs = 0;
      let cpuAfter: ReturnType<typeof readGatewayCpuUsage> | undefined;
      request = get(url, { headers: { accept: "text/event-stream" } }, (res) => {
        headersAt = performance.now();
        response = res;
        record("http", {
          url,
          method: "GET",
          headers: { accept: "text/event-stream" },
          status: res.statusCode,
          responseHeaders: res.headers,
        });
        if (res.statusCode !== 200) {
          failure = new Error("HTTP " + res.statusCode);
          res.resume();
          return;
        }
        res.on("data", (chunk: Buffer) => {
          const receivedAt = performance.now();
          try {
            firstByteAt ??= performance.now();
            if (histories === 0) {
              const now = performance.now();
              transferMaxGapMs = Math.max(transferMaxGapMs, now - lastDataAt);
              lastDataAt = now;
            }
            wireBytes += chunk.length;
            wireHash.update(chunk);
            for (const { frame, raw } of parser.push(chunk)) {
              if (frame.startsWith(": keepalive")) {
                keepalives++;
              }
              if (frame.split(/\r\n|\r|\n/, 1)[0] !== "event: history") {
                continue;
              }
              histories++;
              frameReceivedAt = receivedAt;
              framedAt = performance.now();
              const body = JSON.parse(frame.slice(frame.indexOf("data: ") + 6));
              parsedAt = performance.now();
              const pageSummary = validateHistoryPage(body, sessionKey, count);
              validatedAt = performance.now();
              wireSummary = {
                ...pageSummary,
                frameBytes: Buffer.byteLength(frame),
                frameSha256: sha(frame),
                drainedMs: Date.now() - opened,
              };
              completedAt = performance.now();
              cpuAfter = readGatewayCpuUsage(serving);
              record(prefix + "wire-initial", wireSummary);
              if (values["raw-wire"]) {
                writeFileSync(path.join(output, prefix + "history.sse"), raw);
              }
            }
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
          }
        });
        res.on("error", (error) => {
          if (!closing) {
            failure ??= error;
          }
        });
        res.on("end", () => {
          if (!closing) {
            try {
              parser.finish();
            } catch (error) {
              failure ??= error instanceof Error ? error : new Error(String(error));
            }
            failure ??= new Error("Healthy SSE ended unexpectedly");
          }
        });
        res.on("close", () => {
          if (!closing) {
            failure ??= new Error("Healthy SSE closed unexpectedly");
          }
        });
      });
      request.on("error", (error) => {
        if (!closing) {
          failure ??= error;
        }
      });
      async function awaitWire(predicate: () => boolean, budget: number) {
        const until = Date.now() + budget;
        while (!predicate()) {
          assertHealthy();
          if (Date.now() > until) {
            throw new Error("SSE stage timed out");
          }
          await delay(100);
        }
      }
      await awaitWire(() => histories === 1 && keepalives >= 1 && parser.pendingBytes === 0, 60000);
      record(prefix + "drained", {
        histories,
        keepalives,
        wireBytes,
        pendingBytes: parser.pendingBytes,
        responseDestroyed: response?.destroyed,
        responseComplete: response?.complete,
        wireSummary,
      });
      await snapshot(prefix + "open");
      const previousKeepalives = keepalives;
      await awaitWire(() => keepalives > previousKeepalives, 20000);
      record(prefix + "healthy-after-snapshot", {
        keepalives,
        histories,
        pendingBytes: parser.pendingBytes,
        responseDestroyed: response?.destroyed,
        wireSha256: wireHash.digest("hex"),
      });
      closing = true;
      response?.destroy();
      request.destroy();
      await delay(2000);
      await snapshot(prefix + "closed");
      assert(cpuAfter);
      assert(
        completedAt !== undefined &&
          headersAt !== undefined &&
          firstByteAt !== undefined &&
          frameReceivedAt !== undefined &&
          framedAt !== undefined &&
          parsedAt !== undefined &&
          validatedAt !== undefined,
      );
      const operation = {
        prefix,
        wire: wireSummary,
        cpu: measureGatewayCpuUsage(cpuBefore, await cpuAfter),
        transferMaxGapMs,
        load: loadavg(),
        timingMs: {
          headers: headersAt - requestStarted,
          firstByte: firstByteAt - requestStarted,
          completeFrame: frameReceivedAt - requestStarted,
          framed: framedAt - requestStarted,
          parsed: parsedAt - requestStarted,
          validated: validatedAt - requestStarted,
          endToEnd: completedAt - requestStarted,
        },
        framing: {
          scannedBytes: parser.scannedBytes,
          joinedBytes: parser.joinedBytes,
          frames: parser.frames,
        },
      };
      record(prefix + "metrics", operation);
      operations.push(operation);
    }
    await runStream(values.scored ? "cold-" : "");
    if (values.scored) {
      closing = false;
      await runStream("warm-");
    }
    record("result", {
      stages: ["before", "open", "closed"],
      baselineOnly: true,
      observed: true,
      verdict: values.scored ? "scored serial sample" : "heap analysis pending",
      operations,
      stageResources,
    });
  } catch (error) {
    record("failure", {
      message: error instanceof Error ? error.stack : String(error),
      at: new Date().toISOString(),
    });
    throw error;
  } finally {
    clearTimeout(watchdog);
    await cleanup();
  }
}
