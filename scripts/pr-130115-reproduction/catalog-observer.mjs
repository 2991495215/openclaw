// Preparation only. Collect real Gateway responses; never rewrite catalogs or infer a fix.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

if (
  process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.env.RUNNER_OS !== "macOS"
) {
  throw new Error("This observer is for the disposable native proof runner only");
}
if (process.argv.length !== 3) throw new Error("Expected one runner-owned observation specification");
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const root = realpathSync(process.env.RUNNER_TEMP);
const inside = (value) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Expected an absolute proof path");
  const resolved = realpathSync(value);
  if (!resolved.startsWith(root + path.sep)) throw new Error("Proof input escaped RUNNER_TEMP");
  return resolved;
};
const executable = inside(spec.executable);
const entry = inside(spec.entry);
const sqliteLibrary = inside(spec.sqliteLibrary);
const home = inside(spec.home);
const state = inside(spec.state);
const config = inside(spec.config);
const outputParent = inside(path.dirname(spec.output));
const output = path.join(outputParent, path.basename(spec.output));
if (path.basename(spec.output) === "." || path.basename(spec.output) === "..") throw new Error("Invalid output path");
const endpoint = new URL(spec.gatewayUrl);
if (
  endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port ||
  endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/"
) throw new Error("Expected one synthetic loopback Gateway URL");
if (!Array.isArray(spec.fixtures) || spec.fixtures.length === 0) throw new Error("Missing seed inventory");
for (const fixture of spec.fixtures) {
  if (!['codex', 'claude'].includes(fixture.catalogId) || !fixture.threadId || !fixture.sentinel) {
    throw new Error("Incomplete seed inventory entry");
  }
}
mkdirSync(output); // Refuse to overwrite evidence from a previous attempt.
const binaryHash = createHash("sha256").update(readFileSync(executable)).digest("hex");
const environment = {
  PATH: `${path.dirname(executable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home,
  CFFIXED_USER_HOME: home,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: config,
  OPENCLAW_SQLITE_LIBRARY: sqliteLibrary,
  NO_COLOR: "1",
};
let serial = 0;
const calls = [];
const issues = [];
const occurrences = [];
const reads = [];

function call(method, params) {
  const id = ++serial;
  const name = `${String(id).padStart(4, "0")}-${method}.json`;
  const startedAt = new Date().toISOString();
  const result = spawnSync(executable, [
    entry, "gateway", "call", method, "--params", JSON.stringify(params),
    "--expect-url", spec.gatewayUrl, "--timeout", "45000", "--json",
  ], { env: environment, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(path.join(output, name), result.stdout ?? "");
  writeFileSync(path.join(output, name + ".stderr"), result.stderr ?? "");
  calls.push({ id, method, params, startedAt, finishedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, rawFile: name });
  if (result.error || result.status !== 0) throw new Error(`RPC ${method} failed; raw output retained in ${name}`);
  return { id, value: JSON.parse(result.stdout) };
}

function consume(catalogId, observed, queue) {
  if (!Array.isArray(observed.value.catalogs)) throw new Error("Unexpected real catalog response");
  for (const catalog of observed.value.catalogs) {
    if (catalog.id !== catalogId) throw new Error("Catalog identity changed during collection");
    if (catalog.error) issues.push({ kind: "catalog-error", catalogId, callId: observed.id });
    for (const host of catalog.hosts) {
      if (host.error || host.pending || host.connected !== true) {
        issues.push({ kind: "host-incomplete", catalogId, hostId: host.hostId, callId: observed.id });
      }
      for (const row of host.sessions) {
        // Every occurrence is retained, including identical IDs from different hosts.
        occurrences.push({ catalogId, hostId: host.hostId, hostKind: host.kind,
          nodeId: host.nodeId, threadId: row.threadId, sourceHomeId: row.sourceHomeId,
          name: row.name, callId: observed.id });
      }
      if (host.nextCursor) queue.push({ hostId: host.hostId, cursor: host.nextCursor });
    }
  }
}

let collectionError;
try {
  call("node.list", {});
  if (spec.macNodeId) call("node.describe", { nodeId: spec.macNodeId });
  else issues.push({ kind: "mac-node-unidentified" });
  for (const catalogId of [...new Set(spec.fixtures.map((fixture) => fixture.catalogId))]) {
    const queue = [];
    const visited = new Set();
    consume(catalogId, call("sessions.catalog.list", { catalogId, limitPerHost: 1 }), queue);
    let pageCount = 0;
    while (queue.length) {
      if (++pageCount > 40) throw new Error("Catalog exceeded the bounded proof inventory; collection is incomplete");
      const next = queue.shift();
      const key = JSON.stringify(next);
      if (visited.has(key)) throw new Error("Repeated catalog cursor; collection is incomplete");
      visited.add(key);
      consume(catalogId, call("sessions.catalog.list", {
        catalogId, limitPerHost: 1, hostIds: [next.hostId], cursors: { [next.hostId]: next.cursor },
      }), queue);
    }
  }
  for (const fixture of spec.fixtures) {
    const matches = occurrences.filter((row) => row.catalogId === fixture.catalogId && row.threadId === fixture.threadId);
    if (matches.length === 0) issues.push({ kind: "fixture-not-listed", catalogId: fixture.catalogId, threadId: fixture.threadId });
    for (const row of matches) {
      let cursor, sentinelVisible = false;
      const readCallIds = [], seen = new Set();
      do {
        if (readCallIds.length >= 40) throw new Error("Transcript exceeded the bounded synthetic inventory");
        const result = call("sessions.catalog.read", {
          catalogId: row.catalogId, hostId: row.hostId, threadId: row.threadId, limit: 1,
          ...(cursor ? { cursor } : {}), ...(row.sourceHomeId ? { sourceHomeId: row.sourceHomeId } : {}),
        });
        readCallIds.push(result.id);
        if (!Array.isArray(result.value.items)) throw new Error("Unexpected real transcript response");
        sentinelVisible ||= result.value.items.some(item => typeof item.text === "string" && item.text.includes(fixture.sentinel));
        if (result.value.hostId !== row.hostId || result.value.threadId !== row.threadId) {
          issues.push({ kind: "fixture-read-mismatch", callId: result.id, ...row });
        }
        cursor = result.value.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("Transcript repeated a cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      reads.push({ ...row, readCallIds, pageCount: readCallIds.length, sentinelVisible });
      if (!sentinelVisible) issues.push({ kind: "fixture-read-mismatch", ...row });
    }
  }
} catch (error) {
  collectionError = String(error);
} finally {
  const finalBinaryHash = createHash("sha256").update(readFileSync(executable)).digest("hex");
  if (binaryHash !== finalBinaryHash) issues.push({ kind: "cli-binary-changed" });
  writeFileSync(path.join(output, "observation.json"), JSON.stringify({
    status: collectionError || issues.length ? "incomplete_observation" : "observation_collected",
    proofVerdict: "not_assessed",
    binaryHash, finalBinaryHash, calls, occurrences, reads, issues, collectionError,
    requiredExternalEvidence: ["native-worker-process-and-manifest", "native-ui-interaction-and-pixels", "source-and-seed-identity", "before-after-and-mode-controls"],
  }, null, 2));
}
if (collectionError) throw new Error(collectionError);
