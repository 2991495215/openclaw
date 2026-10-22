// Offline Linux benchmark: seed <new-owned-dir> | sample <dir> <A1|B1..A5|B5>.
// Harness: node --import ./scripts/tsx.mjs scripts/perf/memory-forget-measure.mjs ...
// Only seed imports source owners; measured child is always the existing built dist/entry.js.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import wt from "node:worker_threads";
import { zstdDecompressSync } from "node:zlib";
const self = fileURLToPath(import.meta.url),
  repo = path.resolve(path.dirname(self), "../..");
const sha = (data) => createHash("sha256").update(data).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: "wx" });
const now = () => ({
  epochMs: performance.timeOrigin + performance.now(),
  monotonicNs: String(process.hrtime.bigint()),
});
const timeExecutable = "/usr/bin/time";
const timeFormat = '{"userSeconds":%U,"systemSeconds":%S,"exit":%x}';
const timeFieldPrecisionUs = 10000; // GNU Time %U/%S qualified at hundredth-second precision.
const sessionId = "forget-bench-ascii",
  sessionKey = "agent:main:chat:" + sessionId;
const timestamp = "2026-10-20T00:00:00.000Z",
  count = 34401,
  bytes = 463059747,
  max = 13462;
// Symmetric preload: bounded task/limit facts only, never event text or forced GC.
if (process.env.FORGET_BENCH_OBSERVE && wt.isMainThread) {
  const record = (event, value) =>
    fs.appendFileSync(
      process.env.FORGET_BENCH_OBSERVE,
      JSON.stringify({ event, pid: process.pid, ...now(), ...value }) + "\n",
    );
  const Native = wt.Worker;
  wt.Worker = class extends Native {
    constructor(url, options) {
      super(url, options);
      record("worker", { threadId: this.threadId, url: String(url), limits: this.resourceLimits });
    }
    postMessage(value, ...rest) {
      const input = value?.input;
      if (input?.kind === "session-entry") {
        record("task", {
          threadId: this.threadId,
          mode: input.mode,
          originals: input.includeOriginalMessages,
          sessionId: input.options?.sessionId,
        });
      }
      return super.postMessage(value, ...rest);
    }
  };
  const remove = fsp.rm.bind(fsp);
  fsp.rm = async (file, ...rest) => {
    if (String(file).includes("openclaw-session-export-")) {
      try {
        const files = fs.readdirSync(file).map((name) => {
          const s = fs.statSync(path.join(file, name));
          return { bytes: s.size, allocated: s.blocks * 512 };
        });
        record("export-before-cleanup", { directory: String(file), files });
      } catch (error) {
        record("observer-error", { code: error.code });
      }
    }
    return remove(file, ...rest);
  };
  syncBuiltinESMExports();
  process.once("exit", (code) =>
    record("exit", { code, cpu: process.cpuUsage(), usage: process.resourceUsage() }),
  );
} else if (!process.env.FORGET_BENCH_OBSERVE) {
  const [mode, argument, label] = process.argv.slice(2),
    root = path.resolve(argument ?? "");
  assert.ok(["seed", "sample"].includes(mode) && argument, "seed <new-dir> | sample <dir> <label>");
  assert.equal(process.platform, "linux");
  assert.ok(root.startsWith(repo + path.sep), "fixture must be inside this checkout");
  assert.equal(
    fs.realpathSync(path.dirname(root)),
    path.dirname(root),
    "no external symlink carrier",
  );
  const env = {
    PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
    HOME: root + "/home",
    OPENCLAW_HOME: root + "/home",
    OPENCLAW_STATE_DIR: root + "/state",
    OPENCLAW_CONFIG_PATH: root + "/config.json",
    OPENCLAW_PROFILE: "forget-bench",
    TMPDIR: root + "/tmp",
    XDG_CACHE_HOME: root + "/cache",
    XDG_CONFIG_HOME: root + "/xdg",
    XDG_DATA_HOME: root + "/data",
    NODE_DISABLE_COMPILE_CACHE: "1",
    LC_ALL: "C",
    NO_COLOR: "1",
    TERM: "dumb",
  };
  const database = root + "/state/agents/main/agent/openclaw-agent.sqlite";
  const config = {
    agents: { entries: { main: { workspace: root + "/workspace" } } },
    browser: { enabled: false },
    update: { checkOnStart: false },
    discovery: { mdns: { mode: "off" } },
    logging: { file: root + "/product.log" },
  };
  if (mode === "seed") {
    fs.mkdirSync(root, { mode: 0o700 }); // Exclusive, including empty existing directories/symlinks.
    for (const dir of ["home", "state", "tmp", "cache", "xdg", "data", "workspace/memory"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    write(env.OPENCLAW_CONFIG_PATH, config);
    process.env = { ...env };
    const {
      runOpenClawAgentWriteTransaction: transaction,
      closeOpenClawAgentDatabasesAsync: close,
    } = await import("../../src/state/openclaw-agent-db.ts");
    const { writeSessionEntry } =
      await import("../../src/config/sessions/session-accessor.sqlite-entry-store.ts");
    const { appendTranscriptEventsInTransaction: append } =
      await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.ts");
    const { ensureMemoryEntryOriginsSchema, recordMemoryEntryOriginsInDatabase: origins } =
      await import("../../packages/memory-host-sdk/src/memory-entry-origins.ts");
    const options = { agentId: "main", env },
      scope = { ...options, sessionId, sessionKey };
    const time = Date.parse(timestamp),
      id = (n) => "g1-" + String(n).padStart(7, "0");
    const prefix = [
      { type: "session", version: 3, id: "g1-target", timestamp, cwd: "/synthetic/g1" },
      {
        type: "message",
        id: id(0),
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: "Remember the selected G1 synthetic fact.",
          __openclaw: { senderIsOwner: true },
        },
      },
      {
        type: "message",
        id: id(1),
        parentId: id(0),
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "g1-write",
              name: "write",
              arguments: {
                path: "memory/g1-target.md",
                content: "Selected G1 synthetic fact.",
              },
            },
          ],
        },
      },
    ];
    const tool = (n, padding) => ({
      type: "message",
      id: id(n + 2),
      parentId: id(n + 1),
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: "g1-write",
        toolName: "write",
        content: [{ type: "text", text: "a".repeat(13200) }],
      },
      fixturePadding: "p".repeat(padding),
    });
    const size = (event) => Buffer.byteLength(JSON.stringify(event)),
      tools = count - prefix.length;
    const base = size(tool(0, 0)),
      first = max - base;
    const padding =
      bytes - prefix.reduce((sum, e) => sum + size(e) + 1, 0) - tools * (base + 1) - first;
    const per = Math.floor(padding / (tools - 1)),
      extra = padding % (tools - 1);
    assert.ok(first >= per + 1 && per >= 0);
    assert.equal(size(tool(tools - 1, 0)), base);
    function* events() {
      yield* prefix;
      for (let n = 0; n < tools; n++) {
        yield tool(n, n === 0 ? first : per + Number(n <= extra));
      }
    }
    try {
      transaction(
        (db) =>
          writeSessionEntry(db, sessionKey, {
            sessionId,
            createdAt: time,
            updatedAt: time,
            sessionStartedAt: time,
          }),
        options,
      );
      let batch = [],
        batchBytes = 0;
      for (const event of events()) {
        batch.push(event);
        batchBytes += size(event);
        if (batchBytes >= 2 * 1024 * 1024) {
          transaction((db) => append(db, scope, batch), options);
          batch = [];
          batchBytes = 0;
        }
      }
      if (batch.length) {
        transaction((db) => append(db, scope, batch), options);
      }
      transaction(({ db }) => {
        ensureMemoryEntryOriginsSchema(db);
        origins(db, {
          agentId: "main",
          origins: [
            {
              agentId: "main",
              entryKey: "forget-bench-entry",
              sessionId,
              sessionKey,
              originClass: "owner",
              observedAt: time,
            },
          ],
        });
      }, options);
    } finally {
      await close();
    }
    fs.writeFileSync(
      root + "/workspace/memory/g1-target.md",
      "<!-- openclaw-memory-promotion:forget-bench-entry -->\n- Selected G1 synthetic fact.\n",
    );
    fs.writeFileSync(root + "/workspace/memory/control.md", "Unrelated control.\n");
  }
  const { DatabaseSync } = await import("node:sqlite");
  function snapshot(validate = false) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const digest = createHash("sha256");
      let rows = 0,
        total = 0,
        largest = 0,
        toolRows = 0;
      for (const row of db
        .prepare("SELECT event_json,event_zstd FROM transcript_events ORDER BY session_id,seq")
        .iterate()) {
        let text;
        if (typeof row.event_json === "string") {
          text = row.event_json;
        } else if (row.event_json === null && row.event_zstd instanceof Uint8Array) {
          text = zstdDecompressSync(row.event_zstd).toString("utf8");
        } else {
          throw new Error("Invalid stored fixture event payload");
        }
        digest.update(text + "\n");
        rows++;
        total += Buffer.byteLength(text) + 1;
        largest = Math.max(largest, Buffer.byteLength(text));
        if (validate) {
          const event = JSON.parse(text);
          if (event.message?.role === "toolResult") {
            toolRows++;
            assert.equal(Buffer.byteLength(event.message.content[0].text), 13200);
            assert.ok(!event.message.content[0].text.includes("🚀"));
          }
        }
      }
      const tables = {};
      for (const { name } of db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'memory_%' ORDER BY name",
        )
        .all()) {
        if (typeof name !== "string") {
          throw new Error("Invalid SQLite catalog table name");
        }
        tables[name] = sha(
          JSON.stringify(
            db
              .prepare('SELECT * FROM "' + name + '"')
              .all()
              .map((r) => JSON.stringify(r))
              .toSorted(),
          ),
        );
      }
      const files = Object.fromEntries(
        fs
          .readdirSync(root + "/workspace/memory")
          .toSorted()
          .map((name) => [name, sha(fs.readFileSync(root + "/workspace/memory/" + name))]),
      );
      if (validate) {
        assert.equal(toolRows, 34398);
      }
      return { rows, total, largest, transcriptHash: digest.digest("hex"), tables, files };
    } finally {
      db.close();
    }
  }
  const before = snapshot(mode === "seed");
  const actualConfigHash = sha(fs.readFileSync(env.OPENCLAW_CONFIG_PATH));
  assert.equal(actualConfigHash, sha(JSON.stringify(config, null, 2)));
  assert.deepEqual([before.rows, before.total, before.largest], [count, bytes, max]);
  assert.equal(
    before.transcriptHash,
    "a6c33e0a49084d0feee7afa01647fa38a7c7f522cb1f3c841c1c78bde78fe120",
  );
  const binding = {
    fixture: before,
    normalizedConfigHash: sha(JSON.stringify(config).replaceAll(root, "<fixture>")),
    node: process.version,
    executable: fs.realpathSync(process.execPath),
    executableHash: sha(fs.readFileSync(process.execPath)),
    workloadHash: sha(fs.readFileSync(self)),
    timingExecutableHash: sha(fs.readFileSync(timeExecutable)),
    timeFormat,
    entryHash: sha(fs.readFileSync(repo + "/dist/entry.js")),
    build: json(repo + "/dist/.buildstamp"),
    pathCarrier: { root, repo, env },
  };
  if (mode === "seed") {
    write(root + "/fixture.json", binding);
  } else {
    assert.match(label ?? "", /^[AB][1-5]$/u);
    const seeded = json(root + "/fixture.json");
    assert.deepEqual(binding, seeded, "fixture/runtime/source/build binding changed");
    fs.mkdirSync(root + "/" + label);
    const output = root + "/" + label;
    const trace = output + "/observations.jsonl",
      samples = [],
      seen = new Set();
    function disk() {
      const found = [];
      for (const name of fs
        .readdirSync(env.TMPDIR)
        .filter((n) => n.startsWith("openclaw-session-export-"))) {
        try {
          for (const file of fs.readdirSync(path.join(env.TMPDIR, name))) {
            const s = fs.statSync(path.join(env.TMPDIR, name, file));
            found.push({ bytes: s.size, allocated: s.blocks * 512 });
          }
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      }
      return found;
    }
    function sample() {
      const acquired = now(),
        processes = [];
      for (const pid of seen) {
        try {
          const acquiredStart = now(),
            rollup = fs.readFileSync("/proc/" + pid + "/smaps_rollup", "utf8");
          const value = (key) =>
            Number(new RegExp("^" + key + ": +([0-9]+)", "m").exec(rollup)?.[1]) * 1024;
          const rss = value("Rss"),
            pss = value("Pss");
          assert.ok(Number.isFinite(rss) && Number.isFinite(pss));
          processes.push({ pid, acquiredStart, acquiredEnd: now(), rss, pss });
          for (const tid of fs.readdirSync("/proc/" + pid + "/task")) {
            const children = fs.readFileSync("/proc/" + pid + "/task/" + tid + "/children", "utf8");
            for (const id of children.trim().split(/\s+/u).filter(Boolean)) {
              seen.add(Number(id));
            }
          }
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes(error.code)) {
            throw error;
          }
        }
      }
      samples.push({ ...acquired, acquiredEnd: now(), processes, disk: disk() });
    }
    const { runManagedCommand } = await import("../lib/managed-child-process.mts");
    const handles = ["stdout", "stderr", "kernel-time.json"].map((name) =>
      fs.openSync(output + "/" + name, "wx"),
    );
    const args = [
      repo + "/dist/entry.js",
      "--profile",
      "forget-bench",
      "memory",
      "forget",
      "--agent",
      "main",
      "--session",
      sessionId,
      "--dry-run",
      "--json",
    ];
    let timer, samplingError, timePid;
    const start = now(),
      load = os.loadavg();
    let code, runError;
    try {
      code = await runManagedCommand({
        bin: timeExecutable,
        args: [
          "--quiet",
          "--output=/dev/fd/3",
          "--format=" + timeFormat,
          process.execPath,
          ...args,
        ],
        cwd: repo,
        env: {
          ...env,
          NODE_OPTIONS: "--import=" + pathToFileURL(self).href,
          FORGET_BENCH_OBSERVE: trace,
        },
        stdio: ["ignore", ...handles],
        timeoutMs: 120000,
        requireProcessTreeExit: true,
        onReady: (child) => {
          timePid = child.pid; // Known GNU Time wrapper from this exact managed spawn, not inferred.
          seen.add(child.pid);
          timer = setInterval(() => {
            try {
              sample();
            } catch (error) {
              samplingError ??= String(error);
            }
          }, 25);
        },
      });
    } catch (error) {
      runError = String(error.stack ?? error);
    } finally {
      clearInterval(timer);
      for (const fd of handles) {
        fs.closeSync(fd);
      }
    }
    const end = now();
    let after,
      report,
      kernel,
      observations = [],
      postReadError;
    try {
      after = snapshot();
      report = json(output + "/stdout");
      kernel = json(output + "/kernel-time.json");
      observations = fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
    } catch (error) {
      postReadError = String(error.stack ?? error);
    }
    const tasks = observations.filter((r) => r.event === "task" && r.sessionId === sessionId);
    const limits = tasks.map((task) =>
      observations.find(
        (r) => r.event === "worker" && r.pid === task.pid && r.threadId === task.threadId,
      ),
    );
    const exits = observations.filter((r) => r.event === "exit");
    for (const exit of exits) {
      seen.add(exit.pid);
    }
    const kernelCpuUserUs = Math.round(Number(kernel?.userSeconds) * 1e6);
    const kernelCpuSystemUs = Math.round(Number(kernel?.systemSeconds) * 1e6);
    const receipt = {
      label,
      code,
      runError,
      postReadError,
      start,
      end,
      load,
      loadEnd: os.loadavg(),
      binding,
      report,
      before,
      after,
      samples,
      observations,
      samplingError,
      kernel,
      kernelCpuUserUs,
      kernelCpuSystemUs,
      timeFieldPrecisionUs,
      knownTimingWrapper: { pid: timePid, executable: timeExecutable },
      remainingExports: disk(),
      wallMs: Number(BigInt(end.monotonicNs) - BigInt(start.monotonicNs)) / 1e6,
      sampleIntervalMs: 25,
      observedMaxSampleGapMs: Math.max(
        0,
        ...samples
          .slice(1)
          .map((s, i) => Number(BigInt(s.monotonicNs) - BigInt(samples[i].monotonicNs)) / 1e6),
      ),
      observedMaxExportBytes: Math.max(
        0,
        ...samples.map((s) => s.disk.reduce((n, f) => n + (f.bytes ?? 0), 0)),
      ),
      observedMaxExportAllocated: Math.max(
        0,
        ...samples.map((s) => s.disk.reduce((n, f) => n + (f.allocated ?? 0), 0)),
      ),
      observedMaxExportFiles: Math.max(0, ...samples.map((s) => s.disk.length)),
      sampleFirst: samples[0],
      sampleLast: samples.at(-1),
      observedTreePssMax: Math.max(
        ...samples.map((s) => s.processes.reduce((n, p) => n + p.pss, 0)),
      ),
      cpuUserUs: exits.reduce((n, r) => n + r.cpu.user, 0),
      cpuSystemUs: exits.reduce((n, r) => n + r.cpu.system, 0),
      pids: [...seen],
      cpuCoverage:
        "GNU Time kernel waited-child CPU includes descendants waited through parents, not cgroup/orphans; Node exit CPU is an independent crosscheck",
      memoryCoverage:
        "25ms sampled process-tree PSS INCLUDING known GNU Time wrapper, not true peak; no additive Worker-thread RSS/PSS",
    };
    write(output + "/receipt.json", receipt); // Preserve outcome before any assertion; never replace samples.
    assert.equal(runError, undefined);
    assert.equal(postReadError, undefined);
    assert.equal(code, 0);
    assert.equal(kernel?.exit, code);
    assert.ok(Number.isFinite(kernelCpuUserUs) && Number.isFinite(kernelCpuSystemUs));
    assert.ok(kernelCpuUserUs + timeFieldPrecisionUs >= receipt.cpuUserUs);
    assert.ok(kernelCpuSystemUs + timeFieldPrecisionUs >= receipt.cpuSystemUs);
    assert.ok(
      kernelCpuUserUs + kernelCpuSystemUs + 2 * timeFieldPrecisionUs >=
        receipt.cpuUserUs + receipt.cpuSystemUs,
    );
    assert.equal(samplingError, undefined);
    assert.deepEqual(after, before);
    assert.ok(!observations.some((r) => r.event === "observer-error"));
    assert.equal(sha(fs.readFileSync(env.OPENCLAW_CONFIG_PATH)), actualConfigHash);
    assert.equal(receipt.remainingExports.length, 0);
    assert.ok(!fs.readdirSync(env.TMPDIR).some((n) => n.startsWith("openclaw-session-export-")));
    assert.ok(samples.length > 1 && tasks.length > 0);
    for (const record of observations.filter((r) => r.event === "export-before-cleanup")) {
      assert.equal(
        record.files.reduce((n, f) => n + f.bytes, 0),
        bytes + 3 * count,
      );
    }
    for (const worker of limits) {
      assert.ok(worker?.url.endsWith("/config/sessions/session-transcript.worker.js"));
      assert.equal(worker.limits.maxOldGenerationSizeMb, 512);
      assert.equal(worker.limits.maxYoungGenerationSizeMb, 32);
    }
    assert.ok(tasks.every((task) => task.mode === "snapshot" && task.originals === true));
    assert.deepEqual(report.sessionIds, [sessionId]);
    assert.deepEqual(report.entryKeys, ["forget-bench-entry"]);
    assert.deepEqual(
      report.curatedWrites.map((r) => r.relativePath),
      ["memory/g1-target.md"],
    );
    assert.equal(report.dryRun, true);
    assert.equal(report.artifacts.memoryEntries, 1);
    assert.deepEqual(report.artifacts, {
      memoryFiles: 1,
      memoryEntries: 1,
      memoryLines: 0,
      sessionCorpusFiles: 0,
      sessionCorpusLines: 0,
      indexChunks: 0,
      indexSources: 0,
      ftsRows: 0,
      vectorRows: 0,
      embeddingCacheRows: 0,
      shortTermEntries: 0,
      seenHashScopes: 0,
      backups: 0,
      originRows: 1,
    });
    assert.deepEqual(report.refusals, []);
    assert.deepEqual(report.untargetableEntryKeys, []);
    for (const pid of seen) {
      if (pid !== timePid) {
        assert.ok(
          exits.some((r) => r.pid === pid),
          "incomplete CPU receipt for " + pid,
        );
      }
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    write(output + "/qualified.json", {
      receiptHash: sha(fs.readFileSync(output + "/receipt.json")),
      passed: true,
    });
    console.log(
      JSON.stringify({
        label,
        code,
        wallMs: receipt.wallMs,
        observedTreePssMax: receipt.observedTreePssMax,
        kernelCpuUserUs,
        kernelCpuSystemUs,
        nodeCpuUserUs: receipt.cpuUserUs,
        nodeCpuSystemUs: receipt.cpuSystemUs,
        output,
      }),
    );
  }
}
