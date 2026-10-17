// Temporary, opt-in compiler experiment. Never changes the selected repository compiler.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureKyselyTypes } from "../../scripts/generate-kysely-types.mts";
import { applyLocalTsgoPolicy } from "../../scripts/lib/local-check-runtime.mts";
import {
  TSGO_CI_GRAPHS,
  expandTsgoExecutionGraphs,
} from "../../scripts/lib/tsgo-core-test-shards.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const argument = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const group = Number(argument("--group", "0"));
const groups = Number(argument("--groups", "6"));
const repeats = Number(argument("--repeats", "3"));
assert(Number.isInteger(group) && Number.isInteger(groups) && group >= 0 && group < groups);
assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 10);
const directory = path.join(root, ".artifacts/compiler-comparison", "group-" + group);
fs.mkdirSync(directory, { recursive: true });
const dump = (name, value) =>
  fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const require = createRequire(import.meta.url);
const packageFile = require.resolve("typescript/package.json");
const packageData = JSON.parse(fs.readFileSync(packageFile, "utf8"));
const getExePath = (
  await import(pathToFileURL(path.join(path.dirname(packageFile), "lib/getExePath.js")))
).default;
const pinnedBinary = getExePath();
const libraries = path.dirname(pinnedBinary);
const inventory = expandTsgoExecutionGraphs(TSGO_CI_GRAPHS);
const graphs = inventory.filter((_, index) => index % groups === group);
dump("inventory.json", { inventory, group, groups, graphs });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(command + ": " + (result.error?.message ?? result.stderr ?? result.status));
  return result.stdout;
}
const archives = [
  {
    name: "native",
    url: "https://registry.npmjs.org/@tsc-ts/linux-x64-gnu/-/linux-x64-gnu-0.0.2.tgz",
    integrity:
      "sha512-/+IrlTylDCCTqMtmEvV3pH+jWNnsI7I5+pSFFQj5tMFTYA7ArwROsaygtP6voPZtY6o+jFg6G7gPfxpCLPyYRg==",
  },
  {
    name: "reference",
    url: "https://registry.npmjs.org/@typescript/typescript-linux-x64/-/typescript-linux-x64-7.0.2.tgz",
    integrity:
      "sha512-EYdf2cNg7rgCWJnxCdJ+F3V39O8ihb37eHAu1LK8oAFizgTQbPOK7zHHXbPt8rX24COqODXeI3sIf0fCXG7H/A==",
  },
];
for (const entry of archives) {
  const response = await fetch(entry.url);
  if (!response.ok) throw new Error("Download HTTP " + response.status + ": " + entry.url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, expected] = entry.integrity.split("-");
  assert.equal(
    createHash(algorithm).update(bytes).digest("base64"),
    expected,
    entry.name + " integrity",
  );
  const archive = path.join(directory, entry.name + ".tgz");
  fs.writeFileSync(archive, bytes);
  const destination = path.join(directory, entry.name);
  fs.mkdirSync(destination, { recursive: true });
  run("tar", ["--no-same-owner", "-xzf", archive, "-C", destination]);
}
await ensureKyselyTypes(root);
const nativeDirectory = path.join(directory, "native/package/lib");
const referenceDirectory = path.join(directory, "reference/package/lib");
const binaries = { pinned: "/pin/tsc", candidate: "/native/tsc-ts", reference: "/reference/tsc" };
const common = ["--noEmit", "--declaration", "false", "--pretty", "false"];
const resources = { logicalCpuCount: os.availableParallelism(), totalMemoryBytes: os.totalmem() };
const ciEnv = { CI: "true", GITHUB_ACTIONS: "true", OPENCLAW_LOCAL_CHECK: "0" };
const ciPolicy = applyLocalTsgoPolicy([...common], ciEnv, resources);
// Compiler-writable files never enter the artifact upload tree. Host-side reads
// reject symlinks, then publish only parsed numeric metrics as new regular files.
const metricsDirectory = path.join(
  root,
  ".artifacts/compiler-comparison-scratch",
  "group-" + group,
);
const evidenceMetrics = path.join(directory, "metrics");
fs.mkdirSync(metricsDirectory, { recursive: true });
fs.mkdirSync(evidenceMetrics, { recursive: true });

function sandbox(mode) {
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/cache",
    "--dir",
    "/home",
    "--ro-bind",
    root,
    "/work",
  ];
  if (fs.statSync(path.join(root, ".git")).isDirectory()) args.push("--tmpfs", "/work/.git");
  else args.push("--ro-bind", "/dev/null", "/work/.git");
  if (fs.existsSync(path.join(root, ".openclaw"))) args.push("--tmpfs", "/work/.openclaw");
  args.push(
    "--ro-bind",
    libraries,
    "/libs",
    "--ro-bind",
    libraries,
    "/pin",
    "--ro-bind",
    libraries,
    "/reference",
    "--ro-bind",
    path.join(referenceDirectory, "tsc"),
    "/reference/tsc",
    "--ro-bind",
    nativeDirectory,
    "/native",
    "--bind",
    metricsDirectory,
    "/metrics",
    "--chdir",
    "/work",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "LC_ALL",
    "C",
    "--setenv",
    "TSC_TS_LIB_DIR",
    "/libs",
  );
  if (mode === "incremental-cold") {
    for (const name of ["GOMAXPROCS", "GOGC", "GOMEMLIMIT"]) {
      if (ciPolicy.env[name]) args.push("--setenv", name, ciPolicy.env[name]);
    }
  }
  args.push("--");
  return args;
}
const version = Object.fromEntries(
  Object.entries(binaries).map(([name, binary]) => [
    name,
    run("bwrap", [...sandbox(), binary, "--version"]).trim(),
  ]),
);
dump("metadata.json", {
  sourceHead: run("git", ["rev-parse", "HEAD"]).trim(),
  sourceBase: "3ef6f14650dbed451051bd090dede8834f72c9ca",
  runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  workflowRef: process.env.GITHUB_WORKFLOW_REF ?? null,
  node: process.version,
  os: os.release(),
  cpu: os.cpus()[0]?.model,
  cpus: os.availableParallelism(),
  totalMemoryBytes: os.totalmem(),
  loadAverage: os.loadavg(),
  version,
  pinnedPackage: packageData.version,
  pinnedRevision: packageData.gitHead,
  candidateVersion: "0.0.2",
  candidateRevision: "b0dbfb0ea2240b59d51de5de1aae3a35a9f3dc10",
  referenceRevision: "2bd066d87f5bafd315be9f40889d0a60b9e58e0b",
  binarySha256: {
    pinned: hash(fs.readFileSync(pinnedBinary)),
    candidate: hash(fs.readFileSync(path.join(nativeDirectory, "tsc-ts"))),
    reference: hash(fs.readFileSync(path.join(referenceDirectory, "tsc"))),
  },
  libraries:
    "All compilers use repository-pinned library declarations; compiler-directory prefixes normalized only for comparison.",
  libraryManifest: fs
    .readdirSync(libraries)
    .filter((name) => name.startsWith("lib.") && name.endsWith(".d.ts"))
    .map((name) => ({ name, sha256: hash(fs.readFileSync(path.join(libraries, name))) })),
  repeats,
  group,
  groups,
  archives,
  ciPolicy,
  method:
    "Fresh process and empty incremental cache per sample. Warm filesystem after input preflight. GNU time inside secretless sandbox. incremental-cold applies the canonical CI resource policy to both compilers; other modes use explicit direct flags without Go tuning.",
});
run(
  "sh",
  [
    "-c",
    "uname -a; cat /etc/os-release; lscpu; free -h; cat /proc/self/status | grep Cpus_allowed_list; cat /proc/loadavg",
  ],
  { stdio: ["ignore", fs.openSync(path.join(directory, "host.txt"), "w"), "inherit"] },
);
const normalize = (text) => text.replaceAll("/pin/", "/libs/").replaceAll("/reference/", "/libs/");
const flags = (graph, mode) => {
  const incremental = mode.startsWith("incremental-");
  const args = [
    "-p",
    graph.config,
    ...common,
    "--incremental",
    incremental ? "true" : "false",
    ...(incremental ? ["--tsBuildInfoFile", "/cache/project.tsbuildinfo"] : []),
    ...(mode === "single-threaded" ? ["--singleThreaded"] : []),
  ];
  return mode === "incremental-cold" ? applyLocalTsgoPolicy(args, ciEnv, resources).args : args;
};
const records = [];
const parity = [];
function measure(graph, compiler, mode, iteration) {
  const id = [graph.name, mode, compiler, iteration].join("-");
  const stdoutFile = path.join(directory, id + ".stdout");
  const stderrFile = path.join(directory, id + ".stderr");
  const stdoutFd = fs.openSync(stdoutFile, "w");
  const stderrFd = fs.openSync(stderrFile, "w");
  let result;
  try {
    result = spawnSync(
      "bwrap",
      [
        ...sandbox(mode),
        "/usr/bin/time",
        "-f",
        "%e %U %S %M %x",
        "-o",
        "/metrics/" + id + ".time",
        binaries[compiler],
        ...flags(graph, mode),
      ],
      { cwd: root, timeout: 600000, killSignal: "SIGKILL", stdio: ["ignore", stdoutFd, stderrFd] },
    );
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  if (result.error || result.signal)
    throw new Error(id + ": infrastructure failure: " + (result.error?.message ?? result.signal));
  const metricFile = path.join(metricsDirectory, id + ".time");
  const metricFd = fs.openSync(metricFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let metricText;
  try {
    assert(fs.fstatSync(metricFd).isFile(), "Metric input must be a regular file");
    metricText = fs.readFileSync(metricFd, "utf8");
  } finally {
    fs.closeSync(metricFd);
  }
  const metrics = metricText.trim().split(String.fromCharCode(10)).at(-1).split(" ").map(Number);
  assert.equal(metrics.length, 5);
  assert(metrics.every(Number.isFinite), "Invalid metrics " + id);
  const [wallSeconds, userSeconds, sysSeconds, peakRssKiB, exitCode] = metrics;
  assert.equal(result.status, exitCode);
  fs.writeFileSync(
    path.join(evidenceMetrics, id + ".json"),
    JSON.stringify({ wallSeconds, userSeconds, sysSeconds, peakRssKiB, exitCode }),
  );
  const stdout = normalize(fs.readFileSync(stdoutFile, "utf8"));
  const stderr = fs.readFileSync(stderrFile);
  const row = {
    graph: graph.name,
    config: graph.config,
    mode,
    compiler,
    iteration,
    flags: flags(graph, mode),
    wallSeconds,
    userSeconds,
    sysSeconds,
    peakRssKiB,
    exitCode,
    diagnosticSha256: hash(stdout),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: stderr.length,
    diagnosticCount: stdout
      .split(String.fromCharCode(10))
      .filter((line) => line.includes("): error TS")).length,
  };
  records.push(row);
  dump("measurements.json", records);
  console.log(JSON.stringify(row));
}
for (const graph of graphs) {
  const proofs = {};
  for (const compiler of ["pinned", "candidate"]) {
    proofs[compiler] = {};
    for (const [label, option] of [
      ["config", "--showConfig"],
      ["files", "--listFilesOnly"],
    ]) {
      const output = normalize(
        run(
          "bwrap",
          [
            ...sandbox("incremental-cold"),
            binaries[compiler],
            ...flags(graph, "incremental-cold"),
            option,
          ],
          { maxBuffer: 64 * 1024 * 1024 },
        ),
      );
      fs.writeFileSync(
        path.join(directory, graph.name + "-" + compiler + "-" + label + ".txt"),
        output,
      );
      proofs[compiler][label] = {
        sha256: hash(output),
        lines: output.split(String.fromCharCode(10)).filter(Boolean).length,
      };
    }
  }
  const equal =
    proofs.pinned.config.sha256 === proofs.candidate.config.sha256 &&
    proofs.pinned.files.sha256 === proofs.candidate.files.sha256;
  parity.push({ graph: graph.name, equal, proofs });
  dump("input-parity.json", parity);
  assert(equal, "Different compiler inputs for " + graph.name);
  const modes = ["incremental-cold"];
  if (["core", "ui", "extensions", "scripts"].includes(graph.name)) modes.push("nonincremental");
  if (graph.name === "core") modes.push("single-threaded", "incremental-unthrottled");
  for (const mode of modes) {
    for (let iteration = 1; iteration <= repeats; iteration++) {
      const order = (iteration + group) % 2 ? ["pinned", "candidate"] : ["candidate", "pinned"];
      for (const compiler of order) measure(graph, compiler, mode, iteration);
    }
  }
  // Version-matched control isolates port differences from the newer checker.
  if (graph.name === "core") {
    for (let iteration = 1; iteration <= repeats; iteration++)
      measure(graph, "reference", "incremental-cold", iteration);
  }
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};
const summary = [];
for (const key of new Set(records.map((row) => [row.graph, row.mode, row.compiler].join("/")))) {
  const selected = records.filter((row) => [row.graph, row.mode, row.compiler].join("/") === key);
  assert.equal(selected.length, repeats);
  summary.push({
    key,
    samples: selected.length,
    medianWallSeconds: median(selected.map((r) => r.wallSeconds)),
    wallRange: [
      Math.min(...selected.map((r) => r.wallSeconds)),
      Math.max(...selected.map((r) => r.wallSeconds)),
    ],
    medianPeakRssGiB: median(selected.map((r) => r.peakRssKiB)) / 1048576,
    exitCodes: [...new Set(selected.map((r) => r.exitCode))],
    diagnosticHashes: [...new Set(selected.map((r) => r.diagnosticSha256))],
  });
}
dump("summary.json", summary);
const lines = [
  "# Compiler comparison: collection complete",
  "",
  "This workflow collects compiler outcomes; a green collection job is NOT a typecheck pass.",
  "",
  "Cold incremental uses the actual CI flag, with empty per-process caches. Both compilers share pinned library inputs.",
  "",
  "| Graph / mode / compiler | Median wall (s) | Median peak RSS (GiB) | Exit codes |",
  "|---|---:|---:|---|",
  ...summary.map(
    (row) =>
      "| " +
      row.key +
      " | " +
      row.medianWallSeconds.toFixed(2) +
      " | " +
      row.medianPeakRssGiB.toFixed(2) +
      " | " +
      row.exitCodes.join(",") +
      " |",
  ),
];
const markdown = lines.join(String.fromCharCode(10));
fs.writeFileSync(path.join(directory, "SUMMARY.md"), markdown);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(
  "Collected " + records.length + " samples for " + graphs.length + " canonical execution graphs.",
);
