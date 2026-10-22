// XCTest changes connection settings. The controller observes real routes and pairs only its already-observed Mac.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.platform !== "darwin") {
  throw new Error("Only the disposable macOS GUI runner may start this observer");
}
const spec = JSON.parse(await readFile(process.argv[2], "utf8"));
const run = promisify(execFile);
const runnerRoot = await realpath(process.env.RUNNER_TEMP);
for (const value of [spec.app, spec.appConfig, spec.output, ...[spec.local, spec.remote].flatMap((target) =>
  [target.executable, target.entry, target.sqliteLibrary, target.home, target.state, target.config])]) {
  if (!(await realpath(value)).startsWith(runnerRoot + path.sep)) throw new Error("Proof path escaped RUNNER_TEMP");
}
for (const target of [spec.local, spec.remote]) {
  const endpoint = new URL(target.gatewayUrl);
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Non-fixture Gateway");
}
if (!Number.isInteger(spec.controlPort) || spec.controlPort < 1024 || spec.controlPort > 65535) {
  throw new Error("Invalid proof control port");
}
const observer = fileURLToPath(new URL("./catalog-observer.mjs", import.meta.url));
const phases = ["local-1", "remote", "local-2", "local-reopened", "local-gateway-restarted"];
let nextPhase = 0;
let active = false;
let firstNodeId;
let restarted = false;
let stopping = false;
const activeCommands = new Map();
const gatewayStates = new Map();
const lifecycle = [];
if (!Array.isArray(spec.gateways) || spec.gateways.length !== 2 ||
    !["gateway-local", "gateway-remote"].every(label => spec.gateways.some(g => g.label === label))) {
  throw new Error("Expected exactly the two task-owned foreground Gateways");
}
for (const gateway of spec.gateways) {
  for (const value of [gateway.executable, gateway.arguments[0], gateway.workingDirectory, gateway.environment.HOME,
    gateway.environment.OPENCLAW_STATE_DIR, gateway.environment.OPENCLAW_CONFIG_PATH, path.dirname(gateway.logFile)]) {
    if (!(await realpath(value)).startsWith(runnerRoot + path.sep)) throw new Error("Gateway path escaped RUNNER_TEMP");
  }
}
await writeFile(path.join(spec.output, "process-launch-context.json"), JSON.stringify({
  controller: { executable: process.execPath, arguments: process.argv.slice(1), workingDirectory: process.cwd() },
  appLaunchEnvironment: spec.appEnvironment,
  gateways: spec.gateways.map(({ label, executable, arguments: args, workingDirectory, environment }) =>
    ({ label, executable, arguments: args, workingDirectory, environment })),
  observerCLI: [spec.local, spec.remote].map(target => ({ executable: target.executable, entry: target.entry,
    workingDirectory: target.home, environment: cliEnvironment(target) })),
}, null, 2));
let lifecycleWrites = Promise.resolve();
const saveLifecycle = () => {
  const bytes = JSON.stringify(lifecycle, null, 2);
  lifecycleWrites = lifecycleWrites.then(() => writeFile(path.join(spec.output, "gateway-lifecycle.json"), bytes));
  return lifecycleWrites;
};

async function ownedRun(executable, args, options) {
  const command = run(executable, args, { ...options, detached: true });
  activeCommands.set(command.child.pid, command);
  try { return await command; } finally { activeCommands.delete(command.child.pid); }
}

async function startGateway(label) {
  const descriptor = spec.gateways.find(g => g.label === label);
  const log = await open(descriptor.logFile, "a");
  if (stopping) { await log.close(); throw new Error("Controller is stopping"); }
  const child = spawn(descriptor.executable, descriptor.arguments, {
    env: descriptor.environment, cwd: descriptor.workingDirectory, detached: true, stdio: ["ignore", log.fd, log.fd],
  });
  const record = { label, pid: child.pid, startedAt: new Date().toISOString(), forced: false };
  lifecycle.push(record);
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    Object.assign(record, { code, signal, finishedAt: new Date().toISOString() }); resolve();
  }));
  child.once("error", error => { record.error = String(error); });
  gatewayStates.set(label, { child, closed, record });
  await log.close();
}

async function stopGateway(label) {
  const state = gatewayStates.get(label);
  if (!state) return;
  if (state.record.finishedAt) throw new Error(`${label} exited unexpectedly before teardown`);
  process.kill(-state.child.pid, "SIGTERM");
  let timer;
  const graceful = await Promise.race([state.closed.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 30000); })]);
  clearTimeout(timer);
  if (!graceful) {
    state.record.forced = true;
    process.kill(-state.child.pid, "SIGKILL");
    await state.closed;
  }
  await saveLifecycle();
  if (!graceful || state.record.code !== 0) throw new Error(`${label} did not drain cleanly`);
}

async function waitForGateway(label) {
  const target = label === "gateway-local" ? spec.local : spec.remote;
  const directory = path.join(spec.output, `${label}-ready-${lifecycle.length}`);
  await mkdir(directory);
  const deadline = Date.now() + 90000;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (stopping) throw new Error("Controller stopped during Gateway admission");
    if (gatewayStates.get(label).record.finishedAt) throw new Error(`${label} exited during startup`);
    try {
      await rpc(target, "health", {}, directory, `health-${++attempt}`);
      return;
    } catch {
      if (Date.now() >= deadline) break;
      await delay(1000);
    }
  }
  throw new Error(`${label} never answered the real health RPC; attempts were retained`);
}

function cliEnvironment(target) {
  return { PATH: `${path.dirname(target.executable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: target.home, CFFIXED_USER_HOME: target.home,
    OPENCLAW_STATE_DIR: target.state, OPENCLAW_CONFIG_PATH: target.config,
    OPENCLAW_SQLITE_LIBRARY: target.sqliteLibrary, NO_COLOR: "1" };
}

async function rpc(target, method, params, directory, name, requestTimeoutMs = 45000) {
  let stdout = "", stderr = "", error;
  try {
    ({ stdout, stderr } = await ownedRun(target.executable, [target.entry, "gateway", "call", method,
      "--params", JSON.stringify(params), "--expect-url", target.gatewayUrl,
      "--timeout", String(requestTimeoutMs), "--json"],
    { env: cliEnvironment(target), cwd: target.home, timeout: requestTimeoutMs + 15000, maxBuffer: 16 * 1024 * 1024 }));
  } catch (caught) {
    error = caught; stdout = caught.stdout ?? ""; stderr = caught.stderr ?? "";
  }
  await writeFile(path.join(directory, `${name}.json`), stdout);
  await writeFile(path.join(directory, `${name}.stderr`), stderr);
  if (error) throw new Error(`${method} failed; raw evidence retained`, { cause: error });
  return JSON.parse(stdout);
}

async function observe(phase) {
  const target = phase === "remote" ? spec.remote : spec.local;
  const mode = phase === "remote" ? "remote" : "local";
  const directory = path.join(spec.output, phase);
  await mkdir(directory); // Repeated requests cannot replace previous evidence.
  const routeDeadline = Date.now() + 30000;
  const routeObservations = [];
  let routeReady = false;
  while (Date.now() < routeDeadline) {
    const config = JSON.parse(await readFile(spec.appConfig, "utf8"));
    routeObservations.push({ at: new Date().toISOString(), mode: config.gateway?.mode,
      remoteUrl: config.gateway?.remote?.url, localPort: config.gateway?.port });
    routeReady = config.gateway?.mode === mode && (mode === "local"
      ? Number(config.gateway?.port) === Number(new URL(target.gatewayUrl).port)
      : typeof config.gateway?.remote?.url === "string" && new URL(config.gateway.remote.url).href === new URL(target.gatewayUrl).href);
    if (routeReady) break;
    await delay(1000);
  }
  await writeFile(path.join(directory, "route-readiness.json"), JSON.stringify(routeObservations, null, 2));
  if (!routeReady) throw new Error("The real app did not commit the expected connection mode/endpoint");
  await writeFile(path.join(directory, "route.json"), JSON.stringify({ mode, gatewayUrl: target.gatewayUrl }));
  const deadline = Date.now() + 60000;
  let macNode;
  let attempt = 0;
  const approved = new Set();
  while (Date.now() < deadline) {
    const nodes = await rpc(target, "node.list", {}, directory, `node-ready-${++attempt}`);
    const connected = nodes.nodes.filter((node) => node.connected === true);
    if (connected.length > 1) throw new Error("The isolated Gateway has more than one connected node");
    if (connected.length === 1) {
      macNode = connected[0];
      break;
    }
    if (mode === "remote" && firstNodeId) {
      const pairing = await rpc(target, "node.pair.list", {}, directory, `node-pairing-${attempt}`);
      const own = pairing.pending?.filter((request) => request.nodeId === firstNodeId) ?? [];
      if (own.length > 1) throw new Error("Ambiguous pending pairing for the observed Mac");
      if (own.length === 1 && !approved.has(own[0].requestId)) {
        approved.add(own[0].requestId);
        await rpc(target, "node.pair.approve", { requestId: own[0].requestId }, directory, `node-pairing-approved-${attempt}`);
      }
    }
    await delay(1000); // Bounded startup readiness; all attempts remain in the evidence.
  }
  if (!macNode || !/^(macos|darwin)/i.test(macNode.platform ?? "")) throw new Error("The real Mac node did not connect");
  if (firstNodeId && macNode.nodeId !== firstNodeId) throw new Error("Mac node identity changed across the mode transition");
  firstNodeId ??= macNode.nodeId;
  const description = await rpc(target, "node.describe", { nodeId: macNode.nodeId }, directory, "node-description");
  if (!macNode.commands?.includes("system.which")) throw new Error("The worker's harmless readiness command is not advertised");
  const workerResult = await rpc(target, "node.invoke", { nodeId: macNode.nodeId, command: "system.which",
    params: { bins: ["sh"] }, timeoutMs: 30000, idempotencyKey: randomUUID() }, directory, "worker-readiness");
  const workerPayload = workerResult.payloadJSON ? JSON.parse(workerResult.payloadJSON) : workerResult.payload;
  if (workerResult.ok !== true || workerResult.nodeId !== macNode.nodeId ||
      workerResult.command !== "system.which" || typeof workerPayload?.bins?.sh !== "string") {
    throw new Error("The real worker did not return the expected harmless command result");
  }

  const { stdout: censusJSON } = await run(spec.pythonExecutable,
    ["-I", "-S", "-B", fileURLToPath(new URL("./process-custody.py", import.meta.url)), "snapshot", spec.processCustody],
    { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  const census = JSON.parse(censusJSON);
  await writeFile(path.join(directory, "app-processes.json"), JSON.stringify(census, null, 2));
  if (census.issues.length) throw new Error("Kernel process census was incomplete; worker identity is unproven");
  const appExecutable = await realpath(path.join(spec.app, "Contents/MacOS/OpenClaw"));
  const workerExecutable = await realpath(path.join(spec.app, "Contents/Resources/runtime/bin/bun"));
  const appProcesses = census.processes.filter(row => row.executable === appExecutable);
  if (appProcesses.length !== 1) throw new Error("Cannot identify exactly one proof app incarnation");
  const descendants = new Set([appProcesses[0].identity]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of census.processes) {
      if (row.observedParents.some(parent => descendants.has(parent)) && !descendants.has(row.identity)) {
        descendants.add(row.identity); changed = true;
      }
    }
  }
  const runtimes = census.processes.filter(row => descendants.has(row.identity) && row.executable === workerExecutable);
  if (runtimes.length !== 1) {
    throw new Error("The app's private Bun worker incarnation is missing or ambiguous despite the command response");
  }
  const observationSpec = { ...target, macNodeId: macNode.nodeId, output: path.join(directory, "rpc") };
  const input = path.join(directory, "observer-input.json");
  await writeFile(input, JSON.stringify(observationSpec));
  await ownedRun(process.execPath, [observer, input], { cwd: target.home, timeout: 180000, maxBuffer: 1024 * 1024 });
  const observation = JSON.parse(await readFile(path.join(directory, "rpc", "observation.json"), "utf8"));
  if (observation.status === "incomplete_observation") {
    // Preserve the failed catalog observation. These read-only replays expose the
    // node boundary error that providers intentionally normalize for their UI.
    const diagnostics = [];
    const attempted = new Set();
    for (const issue of observation.issues) {
      if (issue.kind !== "host-incomplete" || issue.hostId !== `node:${macNode.nodeId}` ||
          !["codex", "claude"].includes(issue.catalogId) || attempted.has(issue.catalogId)) continue;
      const call = observation.calls.find(item => item.id === issue.callId);
      if (call?.method !== "sessions.catalog.list") continue;
      const response = JSON.parse(await readFile(path.join(directory, "rpc", call.rawFile), "utf8"));
      const host = response.catalogs.find(item => item.id === issue.catalogId)?.hosts
        .find(item => item.hostId === issue.hostId);
      if (host?.error?.code !== "NODE_INVOKE_FAILED") continue;
      attempted.add(issue.catalogId);
      const codex = issue.catalogId === "codex";
      const command = codex ? "codex.appServer.threads.list.v1" : "anthropic.claude.sessions.list.v1";
      const params = { ...(codex ? { agentId: call.params.agentId ?? "main" } : {}),
        limit: call.params.limitPerHost,
        ...(call.params.search ? { searchTerm: call.params.search } : {}),
        ...(call.params.cursors?.[issue.hostId] ? { cursor: call.params.cursors[issue.hostId] } : {}) };
      const timeoutMs = codex ? 65000 : 30000;
      const record = { catalogId: issue.catalogId, originalCallId: call.id, command, params, timeoutMs,
        note: "Separate CLI read-only diagnostic; does not replace the provider observation or its caller scope",
        startedAt: new Date().toISOString() };
      try {
        record.response = await rpc(target, "node.invoke", { nodeId: macNode.nodeId, command, params,
          timeoutMs, idempotencyKey: randomUUID() }, directory, `node-catalog-diagnostic-${issue.catalogId}`, timeoutMs + 15000);
      } catch (error) {
        record.transportError = String(error);
      }
      record.finishedAt = new Date().toISOString();
      diagnostics.push(record);
      await writeFile(path.join(directory, "node-catalog-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
      if (record.response?.ok === true) {
        const readDiagnostic = record.catalogRead = {
          method: "sessions.catalog.read", requestTimeoutMs: timeoutMs + 15000,
          note: "Separate authorized catalog read; never fills or changes the original list observation",
          startedAt: new Date().toISOString(),
        };
        try {
          const page = typeof record.response.payloadJSON === "string"
            ? JSON.parse(record.response.payloadJSON) : record.response.payload;
          const threadId = page?.sessions?.[0]?.threadId;
          if (typeof threadId !== "string" || !threadId.trim() ||
              (codex && (typeof page?.sourceHomeId !== "string" || !page.sourceHomeId.trim()))) {
            readDiagnostic.skipped = "The node response did not provide a complete observed locator";
          } else {
            readDiagnostic.params = { catalogId: issue.catalogId, hostId: issue.hostId, threadId, limit: 1,
              ...(call.params.agentId ? { agentId: call.params.agentId } : {}),
              ...(codex ? { sourceHomeId: page.sourceHomeId } : {}) };
            readDiagnostic.response = await rpc(target, readDiagnostic.method, readDiagnostic.params,
              directory, `node-catalog-read-diagnostic-${issue.catalogId}`, readDiagnostic.requestTimeoutMs);
          }
        } catch (error) {
          readDiagnostic.error = String(error);
        }
        readDiagnostic.finishedAt = new Date().toISOString();
        await writeFile(path.join(directory, "node-catalog-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
      }
    }
  }
  return { phase, mode, nodeId: macNode.nodeId, description, workerResult, observation };
}

const startup = (async () => {
  for (const label of ["gateway-local", "gateway-remote"]) {
    if (stopping) throw new Error("Controller stopped before Gateway admission");
    await startGateway(label);
    await waitForGateway(label);
  }
  await saveLifecycle();
})();
startup.catch(() => {});
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/live" && req.method === "GET") { res.end('{"live":true}'); return; }
  if (pathname === "/ready" && req.method === "GET") {
    try { await startup; res.end('{"ready":true}'); }
    catch (error) { res.writeHead(503); res.end(JSON.stringify({ error: String(error) })); }
    return;
  }
  if (pathname === "/restart-local" && req.method === "POST") {
    if (active || restarted || nextPhase !== 4) { res.writeHead(409); res.end("{}"); return; }
    active = true;
    try {
      await stopGateway("gateway-local");
      await startGateway("gateway-local");
      await waitForGateway("gateway-local");
      restarted = true;
      await saveLifecycle();
      res.end('{"restarted":true}');
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
    finally { active = false; }
    return;
  }
  const phase = pathname.replace(/^\/snapshot\//, "");
  if (req.method !== "POST" || !phases.includes(phase)) { res.writeHead(404); res.end("{}"); return; }
  if (active || phases[nextPhase] !== phase || (nextPhase === 4 && !restarted)) { res.writeHead(409); res.end('{"error":"unexpected observation order"}'); return; }
  active = true;
  try {
    const result = await observe(phase);
    nextPhase++;
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500); res.end(JSON.stringify({ phase, error: String(error), proofVerdict: "not_assessed" }));
  } finally { active = false; }
});
server.listen(spec.controlPort, "127.0.0.1");
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const pid of activeCommands.keys()) {
    try { process.kill(-pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  await Promise.allSettled(activeCommands.values());
  await startup.catch(() => {});
  const results = await Promise.allSettled([stopGateway("gateway-local"), stopGateway("gateway-remote")]);
  await saveLifecycle();
  process.exit(results.some(result => result.status === "rejected") ? 1 : 0);
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
