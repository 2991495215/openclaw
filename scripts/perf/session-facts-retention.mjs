// Owner-only capsule: run on the benchmark host with Node 26 and --expose-gc.
// Alternate fresh baseline/candidate processes at least five times. No live Gateway or database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "owner-dir": { type: "string" },
    "start-file": { type: "string" },
    side: { type: "string" },
    sessions: { type: "string", default: "10800" },
    page: { type: "string", default: "40" },
    "expect-bound": { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(values["owner-dir"], "--owner-dir must contain the two src/gateway owner files");
const sessions = Number(values.sessions);
const pageSize = Number(values.page);
assert(Number.isSafeInteger(sessions) && sessions > 0);
assert(Number.isSafeInteger(pageSize) && pageSize > 0 && sessions % (2 * pageSize) === 0);
const ownerDir = resolve(values["owner-dir"]);
const ownerUrl = pathToFileURL(
  resolve(ownerDir, "src/gateway/server-plugin-session-facts.ts"),
).href;
const readUrl = pathToFileURL(resolve(ownerDir, "src/gateway/session-facts-read.ts")).href;
const ownerSources = new Map(
  [ownerUrl, readUrl].map((url) => [url, readFileSync(new URL(url), "utf8")]),
);
const config = {};
let factsReads = 0;
let preparedPrReads = 0;
const targets = Array.from({ length: sessions }, (_, index) => ({
  key: `agent:main:retention-${index}`,
  agentId: "main",
  storeTarget: { storePath: "/synthetic/sessions.json" },
  entry: { sessionId: `retention-${index}`, lifecycleRevision: "1", updatedAt: 1 },
  generation: {},
  databaseFactsRevision: 1,
}));
const targetsByKey = new Map(targets.map((target) => [target.key, target]));
const rosters = new Map([
  ["left", []],
  ["right", []],
]);
const projection = {
  state: {
    cfg: config,
    policyConfig: config,
    revision: {},
    rowContext: { subagentRuns: { atTime: () => [] } },
  },
  onFactsChange() {},
  onSelectionChange() {},
  withSelectionPreparation: (run) => run(),
  prepareSelection: async () => {},
  prepareMembership: async () => {},
  needsSelectionPreparation: () => false,
};
const prOwner = {
  readPrepared(target) {
    preparedPrReads++;
    return {
      status: "ready",
      rateLimited: false,
      pullRequests: [
        {
          number: 12,
          state: "open",
          title: `PR ${target.key} `.repeat(8),
          url: "https://example.test/pr/12",
        },
      ],
    };
  },
};
const context = { getRuntimeConfig: () => config, controlUiSessionPullRequests: prOwner };
const scope = { client: { identity: "reader" } };
const collaborators = {
  CHAT_SEND_SESSION_KEY_MAX_LENGTH: 1024,
  withAgentRosterFactsBatch: (_cfg, run) => run(),
  getRuntimeConfigSnapshotMetadata: () => undefined,
  getPluginRuntimeGatewayRequestScope: () => scope,
  isIncognitoSessionKey: () => false,
  readUserProfileVersion: () => 1,
  readGatewayAccessRevision: () => 1,
  operatorReadShareKey: () => "reader",
  withInProcessGatewayRead: (_params, run) => run({ context, client: scope.client }, () => {}),
  canTrustedOfficialPluginRequestScopes: () => true,
  sessionClassificationForRow: () => ({ isMain: false }),
  transientSessionKeys: () => new Set(),
  resolveRequestedSessionAgentId: () => ({ ok: true, agentId: "main" }),
  tryResolveSessionCompatibilityOwnerAgentId: () => "main",
  withReadySessionRows: async (_projection, queries, consume) => {
    const keys = new Set(queries(config).map(({ key }) => key));
    return consume({
      state: projection.state,
      physicalPaths: [],
      describe({ key }) {
        assert(keys.has(key));
        factsReads++;
        const target = targetsByKey.get(key);
        assert(target);
        // Materialized rows are released with the prepared read, as archived-page rows can be.
        // Their weak facts cache must not keep the selected facts alive after roster departure.
        return {
          ...target,
          materialized: {
            row: {
              worktree: { id: key },
              label: `Label ${key} `.repeat(12),
              derivedTitle: `Title ${key} `.repeat(12),
              lastMessagePreview: `Preview ${key} `.repeat(20),
              isMain: false,
              updatedAt: 1,
            },
          },
        };
      },
    });
  },
  getSessionRowProjection: () => projection,
  requireSessionRowProjection: () => projection,
  resolveSessionVisibility: () => "private",
  prepareProjectedSessionSharing: () => ({}),
  prepareProjectedSessionList: ({ opts }) => ({
    prepared: { cfg: config, getTarget: (key) => targetsByKey.get(key) },
    filters: opts.agentId,
    presentation: { select: (_opts, run) => run() },
  }),
  selectSessionEntries: (name) => ({
    entries: rosters.get(name).map((target) => [target.key, target.entry]),
  }),
  resolveProjectedControlUiSessionPrTarget: (_cfg, record) => ({ key: record.key }),
  createVisibleActiveSessionRunProjector: () => () => ({ active: false }),
  projectGatewaySessionRunState: () => ({ fields: { status: "done" } }),
  truncateUtf16Safe: (text, length) => text.slice(0, length),
  stripMarkdown: (text) => text,
};
const fixtureKey = Symbol.for("openclaw.perf.sessionFactsRetention");
Reflect.set(globalThis, fixtureKey, collaborators);
const fixtureModule = `data:text/javascript,${encodeURIComponent(
  Object.keys(collaborators)
    .map(
      (name) =>
        `export const ${name} = globalThis[Symbol.for("openclaw.perf.sessionFactsRetention")].${name};`,
    )
    .join("\n"),
)}`;
const immutableUrl = new URL("../../src/shared/immutable-data.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, moduleContext, nextResolve) {
    if (ownerSources.has(moduleContext.parentURL)) {
      if (specifier === "./session-facts-read.js") {
        return { url: readUrl, shortCircuit: true };
      }
      if (specifier === "../shared/immutable-data.js") {
        return { url: immutableUrl, shortCircuit: true };
      }
      if (!specifier.startsWith("node:")) {
        return { url: fixtureModule, shortCircuit: true };
      }
    }
    return nextResolve(specifier, moduleContext);
  },
  load(url, moduleContext, nextLoad) {
    const source = ownerSources.get(url);
    if (source === undefined) {
      return nextLoad(url, moduleContext);
    }
    // Identical read-only observation on both sides; no production export or behavior patch.
    const observation =
      url === ownerUrl
        ? "\nexport function inspectRetention(projection) { const retained = selectedPrFacts.get(projection); return retained?.facts ?? retained; }\n"
        : "";
    return {
      format: "module",
      source: stripTypeScriptTypes(source + observation),
      shortCircuit: true,
    };
  },
});
const owner = await import(ownerUrl);
async function collect() {
  for (let i = 0; i < 4; i++) {
    await nextTurn();
    global.gc();
  }
}
async function select(name, rows) {
  rosters.set(name, rows);
  projection.state.revision = {};
  await owner.withTrustedPluginSessionFacts({ agentId: name }, async (snapshot) => {
    assert.equal(snapshot.sessions.length, rows.length);
    for (const row of snapshot.sessions) {
      assert.equal(row.unavailable, undefined);
      assert.equal(row.pullRequests[0]?.number, 12);
      assert.equal(row.pullRequestsUnavailable, undefined);
    }
  });
}
try {
  // Equal warmup exercises both scopes and all owner paths before retention capture.
  await select("left", targets.slice(0, pageSize));
  await select("right", targets.slice(pageSize, 2 * pageSize));
  await collect();
  if (values["start-file"]) {
    assert(values.side === "base" || values.side === "candidate");
    const startFile = values["start-file"];
    writeFileSync(`${startFile}.${values.side}.ready`, "ready", { flag: "wx" });
    const deadline = Date.now() + 60_000;
    while (!existsSync(startFile)) {
      assert(Date.now() < deadline, "Timed out waiting for the paired start");
      await delay(10);
    }
    const scheduled = Number(readFileSync(startFile, "utf8"));
    assert(scheduled > Date.now(), "Missed synchronized start");
    await delay(scheduled - Date.now());
    await collect();
  }
  const before = process.memoryUsage().heapUsed;
  factsReads = 0;
  preparedPrReads = 0;
  const entryCheckpoints = [
    { visited: 2 * pageSize, retained: owner.inspectRetention(projection).size },
  ];
  for (let offset = 2 * pageSize; offset < sessions; offset += pageSize) {
    await select(
      (offset / pageSize) % 2 === 0 ? "left" : "right",
      targets.slice(offset, offset + pageSize),
    );
    const visited = offset + pageSize;
    const retained = owner.inspectRetention(projection).size;
    if (values["expect-bound"]) {
      assert.equal(
        retained,
        2 * pageSize,
        "Roster rotation must retain the union, not visited history",
      );
    }
    if (Math.floor(visited / (sessions / 4)) > Math.floor(offset / (sessions / 4))) {
      entryCheckpoints.push({ visited, retained });
    }
  }
  await collect();
  const after = process.memoryUsage().heapUsed;
  const retainedEntries = owner.inspectRetention(projection).size;
  const cycleFactsReads = factsReads;
  const cyclePrReads = preparedPrReads;
  const reentryBefore = factsReads;
  await select("left", targets.slice(0, 1));
  const reentryFactsReads = factsReads - reentryBefore;
  const warmBefore = factsReads;
  await owner.withTrustedPluginSessionFacts({ agentId: "left" }, async (snapshot) => {
    assert.equal(snapshot.sessions[0]?.key, targets[0].key);
    assert.equal(snapshot.sessions[0]?.pullRequests[0]?.number, 12);
  });
  const warmReentryFactsReads = factsReads - warmBefore;
  await collect();
  const beforeClear = process.memoryUsage().heapUsed;
  owner.inspectRetention(projection).clear();
  await collect();
  const releasedCacheBytes = beforeClear - process.memoryUsage().heapUsed;
  console.log(
    JSON.stringify({
      workload:
        "actual selected-session and facts-read owners; synthetic projection, authority, and PR I/O; no Gateway/database/network",
      node: process.version,
      ownerSources: [...ownerSources].map(([url, source]) => ({
        file: new URL(url).pathname,
        sha256: createHash("sha256").update(source).digest("hex"),
      })),
      sessions,
      pageSize,
      scopes: 2,
      retainedEntries,
      entryCheckpoints,
      liveRosterEntries: 2 * pageSize,
      retainedHeapDeltaBytes: after - before,
      releasedCacheBytes,
      cycleFactsReads,
      cyclePrReads,
      reentryFactsReads,
      warmReentryFactsReads,
    }),
  );
  assert.equal(reentryFactsReads, 1, "Reentry must require one facts read");
  assert.equal(warmReentryFactsReads, 0, "Unchanged reentry must reuse the scope snapshot");
  if (values["expect-bound"]) {
    assert.equal(retainedEntries, 2 * pageSize, "Only both scopes' live rosters may remain");
  }
} finally {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, fixtureKey);
}
