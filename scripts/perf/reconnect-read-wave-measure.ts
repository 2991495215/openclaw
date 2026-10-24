// Synthetic state only. Run with node --enable-source-maps --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Profiler } from "node:inspector";
import { findSourceMap } from "node:module";
import { availableParallelism, loadavg, totalmem } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { controlGatewayProfile } from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv, summarizeNumbers } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    output: { type: "string" },
    clients: { type: "string", default: "65" },
    port: { type: "string", default: "19693" },
    profile: { type: "boolean", default: false },
    gateway: { type: "boolean", default: false },
  },
});
assert(values.root && values.output, "--root (generated team-shape fixture) and --output required");
const root = path.resolve(values.root);
const output = path.resolve(values.output);
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const port = integer(values.port, "--port", 19600);
assert(port <= 19699, "use an isolated campaign port in 19600–19699");
const clientCount = integer(values.clients, "--clients", 1);
assert(clientCount <= 256, "--clients is bounded at 256");
const fixture: unknown = JSON.parse(
  readFileSync(path.join(root, "team-shape-summary.json"), "utf8"),
);
assert(
  isRecord(fixture) && fixture.format === "openclaw-team-shape-v1",
  "generated fixture required",
);
assert(typeof fixture.sessionCount === "number" && fixture.sessionCount >= clientCount);
const token = "synthetic-reconnect-read-wave-token";
const configPath = path.join(output, "openclaw.json");
const timeoutMs = 120_000;
const wireSamples: Array<{
  window: string;
  method: string;
  ms: number;
  ok: boolean;
  error?: unknown;
}> = [];
type Peer = ReturnType<typeof createGatewayWsClient>;

if (values.gateway) {
  await runGateway();
} else {
  await runController();
}

async function runGateway() {
  assert(
    process.send && process.env.OPENCLAW_STATE_DIR === root,
    "private benchmark child required",
  );
  writeFileSync(path.join(output, "gateway.pid"), `${process.pid}\n`);
  // The existing IPC profiler tracks workers without exposing a debug listener or product RPC.
  await import("../lib/gateway-bench-profile-preload.ts");
  const { onInternalDiagnosticEvent, waitForDiagnosticEventsDrained } =
    await import("../../src/infra/diagnostic-events.ts");
  const { getTrackedWorkerPoolSnapshot, sampleTrackedWorkerMemory } =
    await import("../../src/infra/worker-cpu.ts");
  const { startGatewayServer } = await import("../../src/gateway/server.js");
  const started = performance.now();
  let window = "startup";
  let dropped = 0;
  const events: Array<Record<string, unknown>> = [];
  const resources: Array<Record<string, unknown>> = [];
  const record = (source: string, raw: unknown) => {
    if (!isRecord(raw)) {
      return;
    }
    if (events.length >= 100_000) {
      dropped++;
      return;
    }
    const event: Record<string, unknown> = { source, window, atMs: performance.now() - started };
    for (const key of [
      "method",
      "operation",
      "phase",
      "outcome",
      "kind",
      "requestClass",
      "workerClass",
      "script",
      "worker",
      "firstResponse",
      "durationMs",
      "queueWaitMs",
      "admissionMs",
      "responseBytes",
      "threadCpuMs",
      "queueMs",
      "preparationMs",
      "hostWaitMs",
      "runMs",
      "transferMs",
      "pendingTasks",
      "pendingBytes",
      "prepareThreadCpuMs",
      "rowThreadCpuMs",
      "responseThreadCpuMs",
      "prepareSyncMs",
      "rowSyncMs",
      "yieldWaitMs",
      "selectedRowCount",
      "materializedRowCount",
      "reusedRowCount",
      "queueDepth",
      "activeTasks",
      "workers",
    ]) {
      const value = raw[key];
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        event[key] = value;
      }
    }
    events.push(event);
  };
  const channels = ["openclaw.gateway.rpc", "openclaw.worker.task", "openclaw.session.list"].map(
    (name) => {
      const source = channel(name);
      const listener = (event: unknown) => record(name, event);
      source.subscribe(listener);
      return () => source.unsubscribe(listener);
    },
  );
  const unsubscribe = onInternalDiagnosticEvent((event) => record("worker.request", event), {
    include: ["worker.request"],
  });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  let beforeCpu = process.threadCpuUsage();
  let beforeProcessCpu = process.cpuUsage();
  let beforeElu = performance.eventLoopUtilization();
  const sample = () => {
    if (resources.length < 10_000) {
      resources.push({
        window,
        atMs: performance.now() - started,
        rssBytes: process.memoryUsage.rss(),
        pools: getTrackedWorkerPoolSnapshot(),
        workers: sampleTrackedWorkerMemory(),
      });
    }
  };
  const sampler = setInterval(sample, 100);
  sampler.unref();
  sample();
  const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  const host = {
    pid: process.pid,
    availableParallelism: availableParallelism(),
    totalmem: totalmem(),
    constrainedMemory: process.constrainedMemory(),
    loadavg: loadavg(),
    node: process.version,
  };
  process.send?.({ channel: "reconnect-wave", id: "ready", host });
  let queue = Promise.resolve();
  process.on("message", (raw: unknown) => {
    if (!isRecord(raw) || raw.channel !== "reconnect-wave" || typeof raw.id !== "string") {
      return;
    }
    const command = raw;
    queue = queue
      .then(async () => {
        if (command.action === "begin") {
          window = String(command.window);
          loop.reset();
          loop.enable();
          beforeCpu = process.threadCpuUsage();
          beforeProcessCpu = process.cpuUsage();
          beforeElu = performance.eventLoopUtilization();
          sample();
        } else if (command.action === "end") {
          await waitForDiagnosticEventsDrained();
          sample();
          loop.disable();
          writeFileSync(
            path.join(output, `${window}-server.json`),
            JSON.stringify(
              {
                host,
                window,
                dropped,
                mainThreadCpu: process.threadCpuUsage(beforeCpu),
                processCpu: process.cpuUsage(beforeProcessCpu),
                eventLoop: {
                  p99Ms: loop.percentile(99) / 1e6,
                  maxMs: loop.max / 1e6,
                  utilization: performance.eventLoopUtilization(beforeElu),
                },
                events: events.filter((event) => event.window === window),
                resources: resources.filter((resource) => resource.window === window),
              },
              null,
              2,
            ),
          );
          if (values.profile && window === "wave") {
            const profilePath = path.join(output, "wave.cpuprofile");
            const profile: Profiler.Profile = JSON.parse(readFileSync(profilePath, "utf8"));
            let mapped = 0;
            for (const { callFrame } of profile.nodes) {
              const entry = findSourceMap(callFrame.url)?.findEntry(
                callFrame.lineNumber,
                callFrame.columnNumber,
              );
              if (entry && "originalSource" in entry && entry.originalSource) {
                callFrame.url = entry.originalSource;
                callFrame.lineNumber = entry.originalLine;
                callFrame.columnNumber = entry.originalColumn;
                mapped++;
              }
            }
            writeFileSync(
              path.join(output, "wave.sourcemapped.cpuprofile"),
              JSON.stringify(profile),
            );
            writeFileSync(
              path.join(output, "profile-mapping.json"),
              JSON.stringify({ mapped, nodes: profile.nodes.length }),
            );
          }
          window = "idle";
        } else if (command.action === "stop") {
          clearInterval(sampler);
          loop.disable();
          unsubscribe();
          for (const unsubscribeChannel of channels) {
            unsubscribeChannel();
          }
          await server.close({ reason: "synthetic reconnect wave complete" });
        }
        process.send?.({ channel: "reconnect-wave", id: command.id });
        if (command.action === "stop") {
          process.disconnect?.();
        }
      })
      .catch((error: unknown) => {
        process.send?.({ channel: "reconnect-wave", id: command.id, error: String(error) });
      });
  });
}

async function rpc(peer: Peer, method: string, params: unknown, window: string) {
  const started = performance.now();
  let recorded = false;
  try {
    const response = await peer.request(method, params, timeoutMs);
    wireSamples.push({
      window,
      method,
      ms: performance.now() - started,
      ok: response.ok,
      ...(!response.ok ? { error: response.error } : {}),
    });
    recorded = true;
    assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
    return response.payload;
  } catch (error) {
    if (!recorded) {
      wireSamples.push({
        window,
        method,
        ms: performance.now() - started,
        ok: false,
        error: String(error),
      });
    }
    throw error;
  }
}

async function runController() {
  mkdirSync(output, { recursive: false });
  const cfg: OpenClawConfig = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
  cfg.gateway = {
    ...cfg.gateway,
    port,
    auth: { mode: "token", token },
    controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
  };
  cfg.diagnostics = { ...cfg.diagnostics, enabled: true };
  writeFileSync(configPath, JSON.stringify(cfg));
  const devices = Array.from({ length: clientCount }, () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
      pair.publicKey.export({ type: "spki", format: "pem" }),
    );
    return {
      publicKey,
      id: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"),
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    };
  });
  const peers = new Set<Peer>();
  let child: ChildProcess | undefined;
  const launch = async (label: string) => {
    const log = createWriteStream(path.join(output, `${label}.log`));
    child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        "--root",
        root,
        "--output",
        output,
        "--port",
        String(port),
        "--clients",
        String(clientCount),
        "--gateway",
        ...(values.profile ? ["--profile"] : []),
      ],
      {
        env: createGatewayBenchEnv(path.join(root, "home"), configPath, {
          startupTrace: false,
          caseEnv: {
            OPENCLAW_STATE_DIR: root,
            TMPDIR: path.join(root, "tmp"),
            OPENCLAW_SKIP_CHANNELS: "1",
          },
        }),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    child.once("close", () => log.end());
    await waitReply(child, "ready");
    return child;
  };
  const connect = async (index: number, window: string) => {
    const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
    const peer = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      openTimeoutMs: timeoutMs,
      handshakeTimeoutMs: timeoutMs,
      onEvent(event) {
        if (
          event.event === "connect.challenge" &&
          isRecord(event.payload) &&
          typeof event.payload.nonce === "string" &&
          typeof event.payload.ts === "number"
        ) {
          challenge.resolve({ nonce: event.payload.nonce, ts: event.payload.ts });
        }
      },
    });
    peers.add(peer);
    await peer.waitOpen();
    const challengeTimer = setTimeout(
      () => challenge.reject(new Error("connect challenge timeout")),
      timeoutMs,
    );
    let signed: { nonce: string; ts: number };
    try {
      signed = await challenge.promise;
    } finally {
      clearTimeout(challengeTimer);
    }
    const device = devices[index]!;
    const scopes = ["operator.admin", "operator.read", "operator.write", "operator.approvals"];
    const client = {
      id: "openclaw-control-ui",
      version: "synthetic",
      platform: "web",
      mode: "webchat",
      instanceId: `synthetic-reconnect-${index}`,
    };
    const payload = buildDeviceAuthPayloadV3({
      deviceId: device.id,
      clientId: client.id,
      clientMode: client.mode,
      platform: client.platform,
      role: "operator",
      scopes,
      signedAtMs: signed.ts,
      token,
      nonce: signed.nonce,
    });
    const hello = await rpc(
      peer,
      "connect",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: "operator",
        scopes,
        auth: { token },
        caps: [],
        device: {
          id: device.id,
          publicKey: device.publicKey,
          signedAt: signed.ts,
          nonce: signed.nonce,
          signature: signEd25519Payload(device.privateKey, payload),
        },
      },
      window,
    );
    assert(
      isRecord(hello) && isRecord(hello.auth) && Array.isArray(hello.auth.scopes),
      "operator auth missing",
    );
    const authorizedScopes = hello.auth.scopes;
    assert(
      scopes.every((scope) => authorizedScopes.includes(scope)),
      "operator scopes missing",
    );
    return peer;
  };
  const boot = async (peer: Peer, index: number, window: string) => {
    const key = `agent:main:team-shape-session-${index}`;
    const roster = rpc(
      peer,
      "sessions.subscribe",
      {
        agentId: "main",
        limit: 100,
        rowMode: "sidebar",
        includeGlobal: true,
        includeUnknown: true,
        includeDerivedTitles: true,
        includeLastMessage: true,
      },
      window,
    );
    const subscribed = rpc(
      peer,
      "sessions.messages.subscribe",
      { key, includeApprovals: true },
      window,
    );
    const results = await Promise.allSettled([
      roster,
      subscribed,
      rpc(peer, "sessions.resolve", { key, agentId: "main" }, window),
      rpc(peer, "board.get", { sessionKey: key, agentId: "main" }, window),
      rpc(peer, "agents.list", {}, window),
      rpc(peer, "users.list", {}, window),
      subscribed.then(() => rpc(peer, "chat.startup", { sessionKey: key, limit: 80 }, window)),
    ]);
    return results.every((result) => result.status === "fulfilled");
  };
  const closePeers = async () => {
    await Promise.all(
      [...peers].map(
        (peer) =>
          new Promise<void>((resolve) => {
            if (peer.ws.readyState === peer.ws.CLOSED) {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              peer.ws.terminate();
              resolve();
            }, 10_000);
            peer.ws.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            peer.close();
          }),
      ),
    );
    peers.clear();
  };
  try {
    // Pair devices and seed boards outside the measured process, then restart with all workers cold.
    await launch("pairing");
    for (let index = 0; index < clientCount; index++) {
      const peer = await connect(index, "setup");
      await rpc(
        peer,
        "board.widget.put",
        {
          sessionKey: `agent:main:team-shape-session-${index}`,
          name: "synthetic-wave-chart",
          title: "Synthetic wave chart",
          content: { kind: "html", html: "<!doctype html><title>Synthetic chart</title><p>42</p>" },
        },
        "setup",
      );
      peer.close();
      peers.delete(peer);
    }
    await command(child!, { action: "stop" });
    await stopChild(child!);
    child = undefined;
    const gateway = await launch("measured");
    await command(gateway, { action: "begin", window: "wave" });
    if (values.profile) {
      await controlGatewayProfile(gateway, "cpu", "start", path.join(output, "wave.cpuprofile"));
    }
    const waveStarted = performance.now();
    const connections = await Promise.allSettled(
      Array.from({ length: clientCount }, async (_, index) => {
        const peer = await connect(index, "wave");
        return await boot(peer, index, "wave");
      }),
    );
    const waveElapsedMs = performance.now() - waveStarted;
    if (values.profile) {
      await controlGatewayProfile(gateway, "cpu", "stop", path.join(output, "wave.cpuprofile"));
    }
    await command(gateway, { action: "end" });
    await closePeers();
    const warm = await connect(0, "warm-connect");
    await command(gateway, { action: "begin", window: "steady" });
    const steadyComplete = await boot(warm, 0, "steady");
    await command(gateway, { action: "end" });
    const report = {
      fixture,
      clientCount,
      waveElapsedMs,
      profiled: values.profile,
      connectionsRejected: connections.filter((result) => result.status === "rejected").length,
      clientsIncomplete: connections.filter(
        (result) => result.status === "rejected" || !result.value,
      ).length,
      steadyComplete,
      windows: Object.fromEntries(
        ["wave", "steady"].map((window) => [
          window,
          Object.fromEntries(
            [
              ...new Set(
                wireSamples.filter((row) => row.window === window).map((row) => row.method),
              ),
            ].map((method) => {
              const rows = wireSamples.filter(
                (row) => row.window === window && row.method === method,
              );
              return [
                method,
                {
                  ...summarizeNumbers(rows.map((row) => row.ms)),
                  p90: rows.map((row) => row.ms).toSorted((a, b) => a - b)[
                    Math.ceil(rows.length * 0.9) - 1
                  ],
                  errors: rows.filter((row) => !row.ok).length,
                },
              ];
            }),
          ),
        ]),
      ),
      wireSamples,
      limitations: [
        "worker.request labels identify worker kinds, not every pool instance; worker.task provides pool script/class",
        "RSS samples cover the Gateway process and its threads, excluding subprocess read workers; per-thread RSS is not independent",
        "RPC admissionMs combines preparation/auth/admission; CPU profiles and worker phases attribute the inner waits",
        "single warm boot is a smoke sample; compare independent fresh-process runs for statistical gates",
        "fixture is mutated by synthetic pairing/board seeding; use a fresh generated copy for each baseline/candidate run",
      ],
    };
    writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, wireSamples: undefined }, null, 2));
    await closePeers();
    await command(gateway, { action: "stop" });
  } catch (error) {
    writeFileSync(
      path.join(output, "failure.json"),
      JSON.stringify({ error: String(error), wireSamples }, null, 2),
    );
    throw error;
  } finally {
    await closePeers();
    if (child) {
      await stopChild(child);
    }
  }
}

function waitReply(child: ChildProcess, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("disconnect", onExit);
      child.off("error", finish);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onMessage = (raw: unknown) => {
      if (isRecord(raw) && raw.channel === "reconnect-wave" && raw.id === id) {
        finish(raw.error ? new Error(String(raw.error)) : undefined);
      }
    };
    const onExit = () => finish(new Error(`Gateway exited waiting for ${id}`));
    const timer = setTimeout(() => finish(new Error(`Gateway IPC timeout: ${id}`)), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("disconnect", onExit);
    child.once("error", finish);
  });
}

async function command(child: ChildProcess, payload: Record<string, string>) {
  const id = `${payload.action}-${performance.now()}`;
  const reply = waitReply(child, id);
  child.send({ channel: "reconnect-wave", id, ...payload });
  await reply;
}
