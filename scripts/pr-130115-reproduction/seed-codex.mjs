// Seed through real user turns. Only the model response is synthetic, over confined loopback.
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.platform !== "darwin") {
  throw new Error("Seed only in the disposable native proof runner, before packaging OpenClaw");
}
const run = promisify(execFile);
const spec = JSON.parse(await readFile(process.argv[2], "utf8"));
const runnerRoot = await realpath(process.env.RUNNER_TEMP);
for (const item of [spec.executable, spec.home, spec.output, ...spec.stores.map((store) => store.root)]) {
  if (!(await realpath(item)).startsWith(runnerRoot + path.sep)) throw new Error("Seed input escaped RUNNER_TEMP");
}
if (!spec.stores.length || new Set(spec.stores.map((store) => store.label)).size !== spec.stores.length) {
  throw new Error("Each source needs a distinct stable label");
}
const temporary = path.join(spec.output, "codex-tmp");
await mkdir(temporary);
const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: spec.home, CFFIXED_USER_HOME: spec.home, TMPDIR: temporary };
const fixtures = [], exchanges = [], modelRequests = [], violations = [], processes = [];
let expectedResponse;
let turnsStarted = 0;
let syntheticModelResponses = 0;
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
});
const model = createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/__canary") {
      response.end("loopback-ready"); return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses" || request.headers.authorization) {
      throw new Error("Unexpected model request path, method or authorization");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error("Oversized synthetic model request");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    modelRequests.push({ method: request.method, path: request.url, body });
    const expected = expectedResponse;
    if (!expected || expected.received || body.model !== "mock-model" || body.stream !== true ||
        !body.input?.some((item) => item.role === "user" && item.content?.some((part) => part.text === expected.sentinel))) {
      throw new Error("Model request does not match the single pending synthetic user turn");
    }
    expected.received = true;
    const id = `synthetic-response-${++syntheticModelResponses}`;
    // Same minimal Responses SSE contract as codex-rs/core/tests/common/responses.rs.
    const events = [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", id: `message-${id}`,
        content: [{ type: "output_text", text: expected.reply }] } },
      { type: "response.completed", response: { id, usage: { input_tokens: 0, input_tokens_details: null,
        output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  })().catch((error) => {
    violations.push(String(error));
    response.writeHead(500); response.end("Synthetic provider rejected unexpected request");
  });
});
const port = await listen(model);
const sandboxFile = path.join(spec.output, "codex-network.sb");
await writeFile(sandboxFile, `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "127.0.0.1:${port}"))\n`);
const confined = (executable, args) => ["-f", sandboxFile, executable, ...args];
let deniedHits = 0;
const denied = createServer((_request, response) => { deniedHits++; response.end("must-not-be-reached"); });
const deniedPort = await listen(denied);
let networkCanaries;
let version;

async function withServer(store, phase, action) {
  const child = spawn("/usr/bin/sandbox-exec", confined(spec.executable, ["app-server", "--listen", "stdio://"]), {
    env: { ...environment, CODEX_HOME: store.root }, cwd: store.root, detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const processRecord = { store: store.label, phase, pid: child.pid, startedAt: new Date().toISOString() };
  processes.push(processRecord);
  let serial = 0, stderr = "", ended = false, fatal;
  const pending = new Map(), waiters = new Set(), notifications = [];
  const fail = (error) => {
    fatal = error;
    for (const entry of [...pending.values(), ...waiters]) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear(); waiters.clear();
  };
  const closed = new Promise((resolve) => child.once("close", (code, signal) => {
    ended = true; fail(new Error("Codex exited before replying")); resolve({ code, signal });
  }));
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", fail); child.stdin.on("error", fail);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error("Non-JSON app-server stdout")); return; }
    exchanges.push({ store: store.label, phase, pid: child.pid, direction: "received", message });
    if (message.method) {
      if (message.id != null) { fail(new Error(`Unexpected server request: ${message.method}`)); return; }
      notifications.push(message);
      for (const entry of waiters) if (entry.matches(message)) {
        clearTimeout(entry.timer); waiters.delete(entry); entry.resolve(message.params);
      }
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    if (ended || fatal) { reject(fatal ?? new Error("Codex is not running")); return; }
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    const message = { jsonrpc: "2.0", id, method, params };
    exchanges.push({ store: store.label, phase, pid: child.pid, direction: "sent", message });
    child.stdin.write(JSON.stringify(message) + "\n");
  });
  const completed = (threadId, turnId) => new Promise((resolve, reject) => {
    const matches = (message) => message.method === "turn/completed" && message.params?.threadId === threadId && message.params?.turn?.id === turnId;
    const prior = notifications.find(matches);
    if (prior) { resolve(prior.params); return; }
    if (fatal) { reject(fatal); return; }
    const entry = { matches, resolve, reject, timer: undefined };
    entry.timer = setTimeout(() => { waiters.delete(entry); reject(new Error("Synthetic turn did not complete")); }, 45000);
    waiters.add(entry);
  });
  try {
    await call("initialize", { clientInfo: { name: "openclaw_catalog_proof", version: "2" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
    await action(call, completed);
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => { if (!ended) process.kill(-child.pid, "SIGTERM"); }, 10000);
    const hard = setTimeout(() => { if (!ended) process.kill(-child.pid, "SIGKILL"); }, 20000);
    const result = await closed;
    Object.assign(processRecord, { finishedAt: new Date().toISOString(), ...result });
    clearTimeout(timer); clearTimeout(hard); lines.close();
    await writeFile(path.join(spec.output, `${store.label}-${exchanges.length}-stderr.log`), stderr);
    if (result.code !== 0 || result.signal) throw new Error("Codex did not finish cleanly; seed is not accepted");
  }
}

async function readVisibleItems(call, fixture) {
  const { thread } = await call("thread/read", { threadId: fixture.threadId, includeTurns: false });
  if (thread.id !== fixture.threadId || thread.name !== fixture.title || !["legacy", "paginated"].includes(thread.historyMode)) {
    throw new Error("Fresh process did not return the expected thread identity, title or history mode");
  }
  const items = [], cursors = new Set();
  let cursor;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const args = { threadId: fixture.threadId, limit: 1, sortDirection: "desc", ...(cursor ? { cursor } : {}) };
    const paginated = thread.historyMode === "paginated";
    const page = await call(paginated ? "thread/items/list" : "thread/turns/list", paginated ? args : { ...args, itemsView: "full" });
    items.push(...(paginated ? page.data.map((entry) => entry.item) : page.data.flatMap((turn) => turn.items)));
    if (!page.nextCursor) {
      const users = items.filter((item) => item.type === "userMessage" && item.content?.some((part) => part.type === "text" && part.text === fixture.sentinel));
      const agents = items.filter((item) => item.type === "agentMessage" && item.text === fixture.reply);
      if (users.length !== 1 || agents.length !== 1) throw new Error("Fresh history lacks one visible user message and synthetic reply");
      return { historyMode: thread.historyMode, readMethod: paginated ? "thread/items/list" : "thread/turns/list", pages: pageNumber + 1 };
    }
    if (cursors.has(page.nextCursor)) throw new Error("History reader repeated its cursor");
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new Error("Synthetic history did not finish paging");
}

try {
  const { stdout } = await run("/usr/bin/sandbox-exec", confined("/usr/bin/curl", ["--silent", "--show-error", "--max-time", "3", `http://127.0.0.1:${port}/__canary`]), { env: environment });
  let deniedExit = 0;
  try {
    await run("/usr/bin/sandbox-exec", confined("/usr/bin/curl", ["--silent", "--show-error", "--max-time", "3", `http://127.0.0.1:${deniedPort}/`]), { env: environment });
  } catch (error) { deniedExit = error.code; }
  networkCanaries = { allowedResponse: stdout, deniedExit, deniedHits, allowedEndpoint: `127.0.0.1:${port}` };
  if (stdout !== "loopback-ready" || !Number.isInteger(deniedExit) || deniedExit === 0 || deniedHits !== 0) throw new Error("Network confinement canaries failed");
  ({ stdout: version } = await run("/usr/bin/sandbox-exec", confined(spec.executable, ["--version"]), { env: environment, timeout: 10000 }));
  version = version.trim();
  if (version.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] !== spec.expectedVersion) throw new Error("Codex version differs from the product pin");
  const executableHash = createHash("sha256").update(await readFile(spec.executable)).digest("hex");
  for (const store of spec.stores) {
    if (!/^[a-z][a-z0-9-]*$/.test(store.label) || (await readdir(store.root)).length !== 0) throw new Error("Each source must be an empty owned directory");
    await writeFile(path.join(store.root, "config.toml"), `model = "mock-model"\nmodel_provider = "catalog_proof"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n[model_providers.catalog_proof]\nname = "Synthetic catalog proof provider"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
    const workspace = path.join(spec.home, `workspace-${store.label}`);
    await mkdir(workspace);
    await withServer(store, "create", async (call, completed) => {
      for (let index = 1; index <= 3; index++) {
        const title = `Catalog proof ${store.label} ${index}`;
        const sentinel = `Synthetic conversation for PR 130115: ${store.label} ${index}.`;
        const reply = `Synthetic loopback reply for PR 130115: ${store.label} ${index}. No external model was used.`;
        const { thread } = await call("thread/start", { cwd: workspace, approvalPolicy: "never", sandbox: "read-only", ephemeral: false, model: "mock-model", modelProvider: "catalog_proof" });
        if (typeof thread?.id !== "string" || !thread.id) throw new Error("Real app-server returned no thread ID");
        expectedResponse = { sentinel, reply, received: false };
        turnsStarted++;
        const { turn } = await call("turn/start", { threadId: thread.id, input: [{ type: "text", text: sentinel, textElements: [] }] });
        if (typeof turn?.id !== "string" || !turn.id) throw new Error("Real app-server returned no turn ID");
        const result = await completed(thread.id, turn.id);
        if (result.turn.status !== "completed" || result.turn.error || !expectedResponse.received || violations.length) throw new Error("Synthetic user turn failed");
        expectedResponse = undefined;
        await call("thread/name/set", { threadId: thread.id, name: title });
        fixtures.push({ catalogId: "codex", owner: store.label, root: store.root, threadId: thread.id, turnId: turn.id, title, sentinel, reply });
      }
    });
    await withServer(store, "fresh-readback", async (call) => {
      const listed = await call("thread/list", { limit: 100, modelProviders: [] });
      for (const fixture of fixtures.filter((item) => item.owner === store.label)) {
        if (!listed.data?.some((row) => row.id === fixture.threadId)) throw new Error("Fresh Codex process did not list the seed");
        fixture.readback = await readVisibleItems(call, fixture);
      }
    });
  }
  if (violations.length || syntheticModelResponses !== turnsStarted || fixtures.length !== turnsStarted) throw new Error("Incomplete synthetic turn ledger");
  await writeFile(path.join(spec.output, "seed.json"), JSON.stringify({ seedVersion: 2, version,
    executable: await realpath(spec.executable), executableHash, validatedAt: new Date().toISOString(), fixtures,
    status: "visible_messages_read_by_fresh_codex_process", turnsStarted, syntheticModelResponses,
    modelResponseMode: "synthetic_loopback", externalModelRequestsPermitted: false, networkCanaries, processes }, null, 2));
} finally {
  await close(model); await close(denied);
  await writeFile(path.join(spec.output, "codex-rpc.json"), JSON.stringify(exchanges, null, 2));
  await writeFile(path.join(spec.output, "model-requests.json"), JSON.stringify({ requests: modelRequests, violations,
    turnsStarted, syntheticModelResponses, networkCanaries }, null, 2));
  await writeFile(path.join(spec.output, "codex-processes.json"), JSON.stringify(processes, null, 2));
}
