// Opt-in compiler comparison. Never changes the selected repository compiler.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureKyselyTypes } from "./generate-kysely-types.mts";
import {
  COMPILER_CACHE_EVIDENCE_LIMIT,
  COMPILER_CACHE_FILE_LIMIT,
  COMPILER_CACHE_POLICY,
  assertCompilerCacheExecution,
  compilerCacheCommand,
  compilerCacheFixture,
  compilerCachePlan,
  readCompilerCacheFile,
  readCompilerCacheOutput,
} from "./lib/compiler-comparison-cache.mts";
import {
  COMPILER_NETWORK_POLICY,
  assertCompilerNetworkIsolation,
  captureCompilerComparisonOutput,
  compilerNetworkDeviceTypes,
  readCompilerComparisonMetrics,
} from "./lib/compiler-comparison-io.mts";
import { applyLocalTsgoPolicy, resolveRepoToolBinPath } from "./lib/local-check-runtime.mts";
import { TSGO_CI_GRAPHS, expandTsgoExecutionGraphs } from "./lib/tsgo-core-test-shards.mts";

const root = fileURLToPath(new URL("../", import.meta.url));

async function main() {
  assert(
    process.platform === "linux" && process.arch === "x64",
    "Use a disposable Linux x64 CI runner",
  );
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Run through the secretless qualification workflow",
  );
  const cacheCorrectness = process.argv.includes("--cache-correctness");
  const inventory = cacheCorrectness
    ? [{ name: "cache-contract", config: "/case/tsconfig.json" }]
    : expandTsgoExecutionGraphs(TSGO_CI_GRAPHS);
  const argument = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? fallback : process.argv[i + 1];
  };
  const containerImage =
    "ubuntu@sha256:a2d43bffc46670d7108bb3c0468c67c5557c4c92e83e1e34cbff1322ad1b94dc";
  const group = Number(argument("--group", "0"));
  const groups = Number(argument("--groups", String(inventory.length)));
  const repeats = Number(argument("--repeats", "3"));
  const memoryTarget = argument("--memory-diagnostic", "");
  const capacityControl = process.argv.includes("--capacity-control");
  const isolationOnly = process.argv.includes("--isolation-diagnostic");
  assert(
    !cacheCorrectness ||
      (!memoryTarget &&
        !capacityControl &&
        !isolationOnly &&
        repeats === 1 &&
        group === 0 &&
        groups === 1 &&
        !process.argv.includes("--canaries")),
    "Cache correctness is one isolated synthetic group",
  );
  assert(!isolationOnly || capacityControl, "Isolation diagnostic requires the capacity profile");
  assert(["", "3GiB", "10GiB"].includes(memoryTarget), "Unknown diagnostic memory target");
  assert(!memoryTarget || (repeats === 1 && !process.argv.includes("--canaries")));
  assert(
    !capacityControl || (!memoryTarget && repeats === 3 && !process.argv.includes("--canaries")),
  );
  assert(Number.isInteger(group) && Number.isInteger(groups) && group >= 0 && group < groups);
  assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 10);
  const directory = path.join(root, ".artifacts/compiler-comparison", "group-" + group);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  // Refuse stale output: partial prior runs must not become evidence for this run.
  fs.mkdirSync(directory);
  const dump = (name, value) =>
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("typescript/package.json");
  const packageData = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const pinnedBinary = resolveRepoToolBinPath("tsgo", { cwd: root });
  const libraries = path.dirname(pinnedBinary);
  const graphs = inventory.filter((_, index) => index % groups === group);
  assert(graphs.length > 0, "Empty compiler group");
  assert(
    !memoryTarget || (graphs.length === 1 && graphs[0].name === "extensions-test"),
    "Memory diagnostic is scoped to the plugin-test graph",
  );
  assert(
    !capacityControl ||
      (graphs.length === 1 && ["extensions", "extensions-test"].includes(graphs[0].name)),
    "Capacity control is scoped to the two incomplete plugin graphs",
  );
  dump("inventory.json", { inventory, group, groups, graphs });

  function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      ...options,
    });
    if (result.error || result.status !== 0) {
      throw new Error(command + ": " + (result.error?.message ?? result.stderr ?? result.status));
    }
    return result.stdout;
  }
  assert.equal(
    run("git", ["status", "--porcelain", "--untracked-files=no"]).trim(),
    "",
    "Commit tracked source before collection",
  );
  const candidateProvenance = {
    distribution: "fork-ci-native",
    repository: "vincentkoc/tsc-ts",
    revision: "a80cd9190942d16286a8483f1f51d9a68037324f",
    runId: 39162206911,
    runAttempt: 1,
    artifactId: 12149466946,
    artifactSha256: "e980b95b04e69c901b59c6ff6f90f8da3d4619dd386cb5067d64233ed28de423",
    tarSha256: "4aebeece3702944225ddd8b957889279510aeeb6246fe9b29a02158268c7c79b",
    binarySha256: "9785e87da1650d3a4007d234bc194c63b640524c010497884e4b93161c7bb149",
  };
  assert(process.env.RUNNER_TEMP, "Missing workflow staging directory");
  const nativeArchive = path.join(process.env.RUNNER_TEMP, "compiler-candidate", "native.tar");
  assert.equal(hash(fs.readFileSync(nativeArchive)), candidateProvenance.tarSha256);
  // Hash the verified member before writing a fixed path; never restore archive
  // paths, links or the unrelated CLI. The candidate runs only inside the sandbox.
  const nativeBinary = run("tar", ["-xOf", nativeArchive, "packages/tsc-ts/dist/tsc"], {
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(hash(nativeBinary), candidateProvenance.binarySha256);
  const nativeDirectory = path.join(directory, "native/package/lib");
  fs.mkdirSync(nativeDirectory, { recursive: true });
  fs.writeFileSync(path.join(nativeDirectory, "tsc-ts"), nativeBinary, { flag: "wx", mode: 0o755 });
  const archives = [
    {
      name: "reference",
      url: "https://registry.npmjs.org/@typescript/typescript-linux-x64/-/typescript-linux-x64-7.0.2.tgz",
      integrity:
        "sha512-EYdf2cNg7rgCWJnxCdJ+F3V39O8ihb37eHAu1LK8oAFizgTQbPOK7zHHXbPt8rX24COqODXeI3sIf0fCXG7H/A==",
    },
  ];
  for (const entry of archives) {
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) {
      throw new Error("Download HTTP " + response.status + ": " + entry.url);
    }
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
  const fixtures = process.argv.includes("--canaries")
    ? JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/compiler-comparison.json"), "utf8"))
    : [];
  const canaries = fixtures.map(({ name, files, compilerOptions, kind, expectedCodes, source }) => {
    const fixtureDirectory = path.join(directory, "canaries", name);
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    for (const [file, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(fixtureDirectory, file), contents);
    }
    const config = path.join(fixtureDirectory, "tsconfig.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          types: [],
          lib: ["es2022"],
          ...compilerOptions,
        },
        files: Object.keys(files).toSorted(),
      }),
    );
    return {
      name: "canary-" + name,
      config: path.relative(root, config),
      kind,
      expectedCodes,
      source,
    };
  });
  const selectedGraphs = [...canaries, ...graphs];
  const referenceDirectory = path.join(directory, "reference/package/lib");
  const binaries = { pinned: "/pin/tsc", candidate: "/native/tsc-ts", reference: "/reference/tsc" };
  const common = ["--noEmit", "--declaration", "false", "--pretty", "false"];
  const cpuSet = fs
    .readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]
    .trim();
  assert(cpuSet, "Missing CPU affinity");
  const memoryCapacity = Math.min(os.totalmem(), process.constrainedMemory() || os.totalmem());
  // The larger control changes only the hard memory cap. Collector affinity must
  // remain four CPUs so the canonical cold checking policy stays constrained.
  if (capacityControl) {
    assert(memoryCapacity >= 30 * 1024 ** 3, "Capacity control requires 30 GiB host headroom");
    assert.equal(os.availableParallelism(), 4, "Capacity control requires four-CPU affinity");
  }
  const memoryBytes = capacityControl
    ? 24 * 1024 ** 3
    : Math.floor((memoryCapacity * 0.8) / 1024 ** 3) * 1024 ** 3;
  assert(memoryBytes > 0, "Missing memory capacity");
  const resources = { logicalCpuCount: os.availableParallelism(), totalMemoryBytes: memoryBytes };
  if (cacheCorrectness) {
    assert.equal(resources.logicalCpuCount, 4);
    assert.equal(memoryBytes, 12 * 1024 ** 3);
    assert.equal(process.versions.node, "24.16.0", "Cache transport requires its pinned runtime");
  }
  if (memoryTarget) {
    assert.equal(resources.logicalCpuCount, 4, "Memory diagnostic requires the original CPU cap");
    assert.equal(memoryBytes, 12 * 1024 ** 3, "Memory diagnostic requires the original RAM cap");
  }
  const modesFor = (graph) =>
    memoryTarget
      ? ["incremental-cold"]
      : graph.kind
        ? ["nonincremental", "single-threaded"]
        : [
            "incremental-cold",
            ...(["core", "ui", "extensions", "scripts"].includes(graph.name)
              ? ["nonincremental"]
              : []),
            ...(graph.name === "core" ? ["single-threaded", "incremental-unthrottled"] : []),
          ];
  const compilers = Object.keys(binaries);
  const cachePlan = cacheCorrectness ? compilerCachePlan() : [];
  const expectedSamples = cacheCorrectness
    ? cachePlan.map((phase) => phase.id)
    : selectedGraphs.flatMap((graph) =>
        modesFor(graph).flatMap((mode) =>
          compilers.flatMap((compiler) =>
            Array.from({ length: repeats }, (_, index) =>
              [graph.name, mode, compiler, index + 1].join("-"),
            ),
          ),
        ),
      );

  const ciEnv = { CI: "true", GITHUB_ACTIONS: "true", OPENCLAW_LOCAL_CHECK: "0" };
  const ciPolicy = applyLocalTsgoPolicy([...common], ciEnv, resources);
  const dockerVersion = isolationOnly
    ? run("docker", [
        "version",
        "--format",
        "{{json .Client.Version}} {{json .Server.Version}}",
      ]).trim()
    : undefined;
  // A soft-target diagnostic keeps the hard cap and checking policy unchanged.
  // Raw GC stderr is evidence only; the auditor refuses this declared profile.
  if (memoryTarget) {
    ciPolicy.env.GOMEMLIMIT = memoryTarget;
    ciPolicy.env.GODEBUG = "gctrace=1";
  }
  // Compiler-writable files never enter the artifact upload tree. Host-side reads
  // reject symlinks, then publish parsed metrics and validated execution evidence.
  const metricsDirectory = path.join(
    root,
    ".artifacts/compiler-comparison-scratch",
    "group-" + group,
  );
  const evidenceMetrics = path.join(directory, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  fs.mkdirSync(evidenceMetrics, { recursive: true });
  // The fixture must not also be reachable through the writable metrics mount.
  const cacheFixtureDirectory = path.join(directory, "fixture");
  if (cacheCorrectness) {
    fs.mkdirSync(cacheFixtureDirectory);
    fs.mkdirSync(path.join(directory, "cache"));
  }
  const cacheBinaryPaths = {
    pinned: pinnedBinary,
    candidate: path.join(nativeDirectory, "tsc-ts"),
    reference: path.join(referenceDirectory, "tsc"),
  };

  function sandbox(mode, containerName, traceGc, cacheTrial) {
    const args = [
      "run",
      "--pull",
      "never",
      "--cpuset-cpus",
      cpuSet,
      "--memory",
      String(memoryBytes),
      "--memory-swap",
      String(memoryBytes),
      "--name",
      containerName,
      "--network",
      "none",
      "--read-only",
      "--user",
      process.getuid() + ":" + process.getgid(),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev",
      "--tmpfs",
      "/cache:rw,nosuid,nodev,size=256m",
      "--workdir",
      "/work",
    ];
    const mount = (source, destination, readonly = true) =>
      args.push(
        "--mount",
        "type=bind,src=" + source + ",dst=" + destination + (readonly ? ",readonly" : ""),
      );
    mount(root, "/work");
    if (fs.statSync(path.join(root, ".git")).isDirectory()) {
      args.push("--tmpfs", "/work/.git:rw,nosuid,nodev");
    } else {
      mount("/dev/null", "/work/.git");
    }
    if (fs.existsSync(path.join(root, ".openclaw"))) {
      args.push("--tmpfs", "/work/.openclaw:rw,nosuid,nodev");
    }
    mount(libraries, "/libs");
    mount(libraries, "/pin");
    mount(libraries, "/reference");
    mount(path.join(referenceDirectory, "tsc"), "/reference/tsc");
    mount(nativeDirectory, "/native");
    mount(metricsDirectory, "/metrics", false);
    mount("/usr/bin/time", "/usr/bin/time");
    if (cacheCorrectness) {
      mount(process.execPath, "/proof-node");
      mount(cacheFixtureDirectory, "/case");
      mount(libraries, "/compiler");
      mount(cacheBinaryPaths[cacheTrial?.compiler ?? "pinned"], "/compiler/tsc");
      if (cacheTrial?.seedFile) {
        mount(cacheTrial.seedFile, "/seed.tsbuildinfo");
      }
    }
    for (const value of [
      "PATH=/usr/bin:/bin",
      "HOME=/tmp",
      "LC_ALL=C",
      "TSC_TS_LIB_DIR=" + (cacheCorrectness ? "/compiler" : "/libs"),
    ]) {
      args.push("--env", value);
    }
    if (mode === "incremental-cold") {
      for (const name of ["GOMAXPROCS", "GOGC", "GOMEMLIMIT", "GODEBUG"]) {
        if (ciPolicy.env[name] && (name !== "GODEBUG" || traceGc)) {
          args.push("--env", name + "=" + ciPolicy.env[name]);
        }
      }
    }
    args.push(containerImage);
    return args;
  }
  let containerSequence = 0;
  const containerPrefix = "compiler-comparison-" + randomUUID() + "-";
  const cancellation = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => cancellation.abort());
  }
  async function executeIsolated(
    args,
    { mode, files, traceGc = false, diagnoseNetwork = false, cacheTrial, ...options } = {},
  ) {
    const name = containerPrefix + containerSequence++;
    let result;
    let networkProfile = null;
    try {
      result = await new Promise((resolve) => {
        const child = spawn("docker", [...sandbox(mode, name, traceGc, cacheTrial), ...args], {
          cwd: root,
          timeout: 120000,
          killSignal: "SIGKILL",
          signal: cancellation.signal,
          ...options,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const output = captureCompilerComparisonOutput(files);
        let error;
        const capture = (chunk, stream) => {
          if (error) {
            return;
          }
          try {
            output.accept(chunk, stream);
          } catch (value) {
            error = value;
            child.kill("SIGKILL");
          }
        };
        child.stdout.on("data", (chunk) => capture(chunk, "stdout"));
        child.stderr.on("data", (chunk) => capture(chunk, "stderr"));
        child.on("error", (value) => {
          error = value;
        });
        child.on("close", (status, signal) =>
          resolve({ status, signal, error, ...output.finish() }),
        );
      });
    } catch (error) {
      result = { status: null, signal: null, error };
    } finally {
      if (diagnoseNetwork) {
        // Inspect this exact container before cleanup. Only selected public
        // runtime fields are evidence; full Docker inspection can expose secrets.
        const inspection = spawnSync(
          "docker",
          [
            "inspect",
            "--format",
            "{{json .HostConfig.NetworkMode}} {{json .HostConfig.Runtime}}",
            name,
          ],
          { encoding: "utf8", timeout: 5000, maxBuffer: 4096 },
        );
        networkProfile = inspection.status === 0 ? inspection.stdout.trim() : null;
      }
      // Inspect before removal: exit 137 alone cannot establish an OOM kill.
      // After a client timeout this is a live snapshot, not a terminal exit code.
      result.preCleanupState = { available: false };
      try {
        const inspection = spawnSync("docker", ["inspect", "--format", "{{json .State}}", name], {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 4096,
        });
        assert(!inspection.error && inspection.status === 0, "Container state unavailable");
        const { Status, Running, OOMKilled, ExitCode } = JSON.parse(inspection.stdout);
        assert(
          ["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(
            Status,
          ) &&
            typeof Running === "boolean" &&
            typeof OOMKilled === "boolean" &&
            Number.isInteger(ExitCode),
          "Malformed container state",
        );
        result.preCleanupState = { available: true, Status, Running, OOMKilled, ExitCode };
      } catch {
        // Missing evidence remains unavailable; it must never become OOMKilled=false.
      }
      // Always join the exact task-owned container, including successful runs.
      // Killing only its client can leave a compiler contaminating later samples.
      const cleanup = spawnSync("docker", ["rm", "--force", name], {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4096,
      });
      result.cleanupVerified =
        !cleanup.error && (cleanup.status === 0 || cleanup.stderr.includes("No such container"));
      if (!result.cleanupVerified) {
        result.error = new Error("Failed to join task-owned container " + name);
      }
      if (diagnoseNetwork) {
        dump("isolation-diagnostic.json", {
          sourceHead: run("git", ["rev-parse", "HEAD"]).trim(),
          runId: process.env.GITHUB_RUN_ID,
          kernel: os.release(),
          collectorNetworkNamespace: fs.readlinkSync("/proc/self/ns/net"),
          dockerVersion,
          limits: { cpuSet, memoryBytes, swapBytes: 0 },
          profile: networkProfile,
          stdout: result.stdout,
          stderr: result.stderr,
          processExitCode: result.status,
          preCleanupState: result.preCleanupState,
          cleanupVerified: result.cleanupVerified,
        });
      }
    }
    return result;
  }
  async function isolatedOutput(args, options = {}) {
    const result = await executeIsolated(args, options);
    if (result.error || result.status !== 0) {
      throw new Error("Isolation: " + (result.error?.message ?? result.stderr ?? result.status));
    }
    return result.stdout;
  }
  const executionEvidence = (result) => ({
    processExitCode: result.status,
    processSignal: result.signal,
    infrastructureError: result.error?.message,
    cleanupVerified: result.cleanupVerified,
    preCleanupState: result.preCleanupState,
  });
  // Read back enforcement from inside the actual mount/resource namespace.
  const limits = (
    await isolatedOutput([
      "sh",
      "-c",
      "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/cpuset.cpus.effective",
    ])
  )
    .trim()
    .split("\n");
  assert.deepEqual(
    limits,
    [String(memoryBytes), "0", cpuSet],
    "Container limits were not enforced",
  );
  if (cacheCorrectness) {
    assert.equal(await isolatedOutput(["/proof-node", "--version"]), "v24.16.0\n");
  }
  const cacheWrapperSmoke = cacheCorrectness ? { exits: [] } : undefined;
  const deadlineCommand = ["sh", "-c", "printf ready > /metrics/deadline-ready; sleep 30"];
  const deadlineSmoke = await executeIsolated(
    cacheCorrectness
      ? compilerCacheCommand(deadlineCommand, "smoke-deadline", false)
      : deadlineCommand,
    { timeout: 3000 },
  );
  assert.equal(fs.readFileSync(path.join(metricsDirectory, "deadline-ready"), "utf8"), "ready");
  assert.equal(deadlineSmoke.signal, "SIGKILL", "Deadline did not terminate the Docker client");
  assert.equal(deadlineSmoke.cleanupVerified, true, "Deadline cleanup was not verified");
  assert.equal(deadlineSmoke.preCleanupState.available, true, "Deadline state was not captured");
  if (cacheCorrectness) {
    assert.throws(() => assertCompilerCacheExecution(executionEvidence(deadlineSmoke), 0));
    assert(!fs.existsSync(path.join(metricsDirectory, "smoke-deadline.cache")));
    cacheWrapperSmoke.deadline = executionEvidence(deadlineSmoke);
  }
  const exitSmoke = [];
  for (const exitCode of [0, 1, 2, 137]) {
    const id = "smoke-exit-" + exitCode;
    const command = [
      "sh",
      "-c",
      (cacheCorrectness ? "printf '{}' > /cache/project.tsbuildinfo; " : "") + "exit " + exitCode,
    ];
    const result = await executeIsolated(
      cacheCorrectness ? compilerCacheCommand(command, id, false) : command,
    );
    assert.ifError(result.error);
    assert.equal(result.status, exitCode);
    assert.equal(result.cleanupVerified, true);
    assert.deepEqual(result.preCleanupState, {
      available: true,
      Status: "exited",
      Running: false,
      OOMKilled: false,
      ExitCode: exitCode,
    });
    exitSmoke.push({ exitCode, preCleanupState: result.preCleanupState });
    if (cacheCorrectness) {
      if (exitCode === 137) {
        assert.throws(() => assertCompilerCacheExecution(executionEvidence(result), exitCode));
      } else {
        assertCompilerCacheExecution(executionEvidence(result), exitCode);
      }
      const output = path.join(metricsDirectory, id + ".cache");
      assert.equal(readCompilerCacheFile(output).toString("utf8"), "{}");
      fs.unlinkSync(output);
      cacheWrapperSmoke.exits.push({
        ...executionEvidence(result),
        cacheSha256: hash("{}"),
        admitted: exitCode !== 137,
      });
    }
  }
  if (cacheCorrectness) {
    const result = await executeIsolated(
      compilerCacheCommand(["sh", "-c", "exit 0"], "smoke-export", false),
    );
    assert.ifError(result.error);
    assert.equal(result.status, 77);
    assert.equal(result.signal, null);
    assert.equal(result.cleanupVerified, true);
    assert.deepEqual(result.preCleanupState, {
      available: true,
      Status: "exited",
      Running: false,
      OOMKilled: false,
      ExitCode: 77,
    });
    assert.throws(() => assertCompilerCacheExecution(executionEvidence(result), 0));
    assert(!fs.existsSync(path.join(metricsDirectory, "smoke-export.cache")));
    cacheWrapperSmoke.exportFailure = executionEvidence(result);
  }
  const probe = ".compiler-isolation-" + randomUUID();
  const probePaths = {
    checkout: path.join(root, probe),
    evidence: path.join(directory, probe),
    metrics: path.join(metricsDirectory, probe),
  };
  for (const file of Object.values(probePaths)) {
    assert(!fs.existsSync(file), "Isolation probe already exists");
  }
  const isolationSmoke = {
    metricsWrite: "verified",
    checkoutWrite: "EROFS",
    evidenceWrite: "EROFS",
    networkEvidence: "network-isolation.json",
  };
  const networkEvidence = {
    policy: COMPILER_NETWORK_POLICY,
    collectorNamespace: fs.readlinkSync("/proc/self/ns/net"),
    probe: "",
  };
  try {
    // Linux EROFS/ENETUNREACH distinguish isolation from missing paths or a
    // refused remote port. The documentation-only address is never a service dependency.
    networkEvidence.probe = await isolatedOutput(
      [
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        `set -eu
fail() { printf '%s\\n' "$1" >&2; exit 1; }
printf '%s' "$1" > "/metrics/$1"
for target in "$2" "$3"; do
  test -d "\${target%/*}" || fail "Missing isolation probe parent"
  if printf forbidden 2>/tmp/write-error > "$target"; then fail "Unexpected writable checkout or evidence"; fi
  [[ "$(</tmp/write-error)" == *"Read-only file system"* ]] || fail "Write failed without EROFS"
done
known_name() {
  case $1 in
    ${[...compilerNetworkDeviceTypes.keys()].join("|")}) printf '%s' "$1" ;;
    *) printf redacted ;;
  esac
}
printf 'namespace\\t%s\\n' "$(readlink /proc/self/ns/net)"
while read -r key value rest; do
  case $key in
    CapInh:|CapPrm:|CapEff:|CapBnd:|CapAmb:) printf 'capability\\t%s\\t%s\\n' "\${key%:}" "$value" ;;
    NoNewPrivs:) printf 'no-new-privs\\t%s\\n' "$value" ;;
  esac
done < /proc/self/status
for interface in /sys/class/net/*; do
  printf 'sysfs\\t%s\\t%s\\t%s\\t%s\\n' "$(known_name "\${interface##*/}")" "$(cat "$interface/type" 2>/dev/null || printf unavailable)" "$(cat "$interface/flags" 2>/dev/null || printf unavailable)" "$(cat "$interface/operstate" 2>/dev/null || printf unavailable)"
done
while IFS=: read -r interface rest; do
  [[ -n $rest ]] || continue
  printf 'proc\\t%s\\n' "$(known_name "\${interface//[[:space:]]/}")"
done < /proc/self/net/dev
while read -r interface rest; do
  [[ $interface == Iface ]] || printf 'route4\\t%s\\n' "$(known_name "$interface")"
done < /proc/self/net/route
printf 'routes4\\tcomplete\\n'
while read -ra route; do
  printf 'route6\\t%s\\n' "$(known_name "\${route[9]}")"
done < /proc/self/net/ipv6_route
printf 'routes6\\tcomplete\\n'
if ( : > /dev/tcp/192.0.2.1/9 ) 2>/tmp/network-error; then fail "Unexpected external TCP connection"; fi
[[ "$(</tmp/network-error)" == *"Network is unreachable"* ]] || fail "TCP failed without ENETUNREACH"
printf 'tcp\\tENETUNREACH\\n'`,
        "isolation-proof",
        probe,
        "/work/" + probe,
        "/work/" + path.relative(root, path.join(directory, probe)),
      ],
      { timeout: 10000, diagnoseNetwork: isolationOnly },
    );
    // The trusted probe records facts; this shared owner decides admission.
    // Publish even rejected observations, but never invoke a compiler after rejection.
    dump("network-isolation.json", networkEvidence);
    assertCompilerNetworkIsolation(networkEvidence);
    assert.equal(fs.readFileSync(probePaths.metrics, "utf8"), probe);
    assert(!fs.existsSync(probePaths.checkout) && !fs.existsSync(probePaths.evidence));
  } finally {
    // A broken mount must not leave even the probe's unexpected writes behind.
    for (const file of Object.values(probePaths)) {
      fs.rmSync(file, { force: true });
    }
  }
  if (isolationOnly) {
    console.log("Isolation diagnostic complete; no compiler was invoked in the sandbox.");
    return;
  }
  const version = {};
  for (const [name, binary] of Object.entries(binaries)) {
    version[name] = (await isolatedOutput([binary, "--version"])).trim();
  }
  dump("metadata.json", {
    sourceHead: run("git", ["rev-parse", "HEAD"]).trim(),
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
    candidateVersion: "unreleased",
    candidateRevision: candidateProvenance.revision,
    candidateProvenance,
    referenceRevision: "2bd066d87f5bafd315be9f40889d0a60b9e58e0b",
    binarySha256: {
      pinned: hash(fs.readFileSync(pinnedBinary)),
      candidate: hash(fs.readFileSync(path.join(nativeDirectory, "tsc-ts"))),
      reference: hash(fs.readFileSync(path.join(referenceDirectory, "tsc"))),
    },
    libraries: cacheCorrectness
      ? "Identical readonly declarations and executable path /compiler for every cache phase; no diagnostic path normalization."
      : "All compilers use repository-pinned library declarations; compiler-directory prefixes normalized only for comparison.",
    libraryManifest: fs
      .readdirSync(libraries)
      .filter((name) => name.startsWith("lib.") && name.endsWith(".d.ts"))
      .toSorted()
      .map((name) => ({ name, sha256: hash(fs.readFileSync(path.join(libraries, name))) })),
    repeats,
    group,
    groups,
    archives,
    ciPolicy,
    memoryDiagnostic: memoryTarget || undefined,
    capacityControl: capacityControl || undefined,
    isolation: "docker",
    isolationSmoke,
    containerImage,
    limits: { cpuSet, memoryBytes, swapBytes: 0 },
    deadlineSmoke: {
      signal: deadlineSmoke.signal,
      cleanupVerified: deadlineSmoke.cleanupVerified,
      preCleanupState: deadlineSmoke.preCleanupState,
    },
    exitSmoke,
    cacheWrapperSmoke,
    expectedSamples,
    cacheCorrectness: cacheCorrectness
      ? {
          policy: COMPILER_CACHE_POLICY,
          compilerPath: "/compiler/tsc",
          libraryPath: "/compiler",
          fixturePath: "/case",
          nodeVersion: process.version,
          nodeBinarySha256: hash(fs.readFileSync(process.execPath)),
          fileLimit: COMPILER_CACHE_FILE_LIMIT,
          scratchLimit: 3 * COMPILER_CACHE_FILE_LIMIT,
          evidenceLimit: COMPILER_CACHE_EVIDENCE_LIMIT,
          performanceEligible: false,
          seedAcceptance: "A seed is offered; compiler cache acceptance is not inferred.",
        }
      : undefined,
    canaries,
    method: cacheCorrectness
      ? "Synthetic cache correctness only. Fresh container per invocation, readonly fixture, one bounded immutable seed and canonical cold CI resource policy. No timing or cache-hit claim."
      : "Fresh process and empty incremental cache per sample. Warm filesystem after input preflight. GNU time inside secretless sandbox. incremental-cold applies the canonical CI resource policy to all three compilers; other modes use explicit direct flags without Go tuning.",
  });
  const normalize = (text) =>
    cacheCorrectness
      ? text
      : text.replaceAll("/pin/", "/libs/").replaceAll("/reference/", "/libs/");
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
  async function measure(graph, compiler, mode, iteration, cacheTrial) {
    const id = cacheTrial?.id ?? [graph.name, mode, compiler, iteration].join("-");
    const stdoutFile = path.join(directory, id + ".stdout");
    const stderrFile = path.join(directory, id + ".stderr");
    const stdoutFd = fs.openSync(stdoutFile, "w");
    const stderrFd = fs.openSync(stderrFile, "w");
    let result;
    try {
      const command = [
        "/usr/bin/time",
        "-f",
        "%e %U %S %M %x",
        "-o",
        "/metrics/" + id + ".time",
        cacheTrial ? "/compiler/tsc" : binaries[compiler],
        ...flags(graph, mode),
      ];
      result = await executeIsolated(
        cacheTrial ? compilerCacheCommand(command, id, Boolean(cacheTrial.seedFile)) : command,
        {
          timeout: 600000,
          killSignal: "SIGKILL",
          mode,
          traceGc: Boolean(memoryTarget),
          files: { stdout: stdoutFd, stderr: stderrFd },
          cacheTrial,
        },
      );
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }
    // Publish execution evidence before fallible metric parsing, even when no
    // valid GNU time record survived. Missing numeric values remain absent.
    const execution = executionEvidence(result);
    const evidenceFile = path.join(evidenceMetrics, id + ".json");
    fs.writeFileSync(evidenceFile, JSON.stringify(execution));
    if (result.error || result.signal) {
      throw new Error(id + ": infrastructure failure: " + (result.error?.message ?? result.signal));
    }
    const metricFile = path.join(metricsDirectory, id + ".time");
    const metrics = readCompilerComparisonMetrics(metricFile);
    const [wallSeconds, userSeconds, sysSeconds, peakRssKiB, exitCode] = metrics;
    fs.writeFileSync(
      evidenceFile,
      JSON.stringify({
        wallSeconds,
        userSeconds,
        sysSeconds,
        peakRssKiB,
        exitCode,
        ...execution,
      }),
    );
    // Reject the producer before a measurement or dependent seed is published.
    const cacheOutput = cacheTrial
      ? readCompilerCacheOutput(path.join(metricsDirectory, id + ".cache"), execution, exitCode)
      : undefined;
    // Keep rejected trials out of measurements while collecting the remaining
    // isolated samples. Their planned IDs keep the audit incomplete.
    if (![0, 1, 2].includes(result.status) || result.status !== exitCode) {
      assert(!cacheTrial, id + ": invalid cache phase execution");
      console.error(
        id + ": rejected sample: process exit " + result.status + ", GNU time " + exitCode,
      );
      return undefined;
    }
    const stdout = normalize(fs.readFileSync(stdoutFile, "utf8"));
    const stderr = fs.readFileSync(stderrFile);
    const row = {
      ...(cacheTrial ? { id } : {}),
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
    return { row, cacheOutput };
  }
  if (cacheCorrectness) {
    const cacheRecords = [];
    const outputs = new Map();
    let evidenceBytes = 0;
    const retain = (name, bytes) => {
      assert(bytes.length <= COMPILER_CACHE_FILE_LIMIT);
      evidenceBytes += bytes.length;
      assert(evidenceBytes <= COMPILER_CACHE_EVIDENCE_LIMIT, "Cache evidence exceeds 256 MiB");
      fs.writeFileSync(path.join(directory, "cache", name), bytes, { flag: "wx" });
      return { file: name, bytes: bytes.length, sha256: hash(bytes) };
    };
    for (const phase of cachePlan) {
      const fixture = compilerCacheFixture(phase.state);
      for (const name of fs.readdirSync(cacheFixtureDirectory)) {
        fs.unlinkSync(path.join(cacheFixtureDirectory, name));
      }
      for (const [name, contents] of Object.entries(fixture)) {
        fs.writeFileSync(path.join(cacheFixtureDirectory, name), contents, { flag: "wx" });
      }
      let seed;
      if (phase.seed) {
        seed = outputs.get(phase.seed);
        assert(seed, "Missing seed phase " + phase.seed);
        const bytes = readCompilerCacheFile(path.join(directory, "cache", seed.file));
        assert.equal(hash(bytes), seed.sha256);
        if (phase.truncate) {
          seed = retain(
            "seed-" + phase.id + ".tsbuildinfo",
            bytes.subarray(0, Math.floor(bytes.length / 2)),
          );
        }
      }
      const measured = await measure(graphs[0], phase.compiler, "incremental-cold", 1, {
        id: phase.id,
        compiler: phase.compiler,
        seedFile: seed ? path.join(directory, "cache", seed.file) : undefined,
      });
      assert(measured?.cacheOutput);
      // executeIsolated has joined the exact container before any writable file is read.
      const outputFile = path.join(metricsDirectory, phase.id + ".cache");
      const output = retain(phase.id + ".tsbuildinfo", measured.cacheOutput);
      fs.unlinkSync(outputFile);
      outputs.set(phase.id, output);
      cacheRecords.push({
        ...phase,
        input: fixture,
        inputSha256: hash(JSON.stringify(fixture)),
        seedCache: seed ?? null,
        outputCache: output,
      });
      dump("cache-contract.json", {
        policy: COMPILER_CACHE_POLICY,
        phases: cacheRecords,
        evidenceBytes,
      });
    }
    console.log("Collected all 56 cache correctness calls; no performance qualification.");
    return;
  }
  for (const graph of selectedGraphs) {
    const proofs = {};
    for (const compiler of compilers) {
      proofs[compiler] = {};
      for (const [label, option] of [
        ["config", "--showConfig"],
        ["files", "--listFilesOnly"],
      ]) {
        const output = normalize(
          await isolatedOutput([binaries[compiler], ...flags(graph, modesFor(graph)[0]), option], {
            mode: modesFor(graph)[0],
          }),
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
      proofs.pinned.files.sha256 === proofs.candidate.files.sha256 &&
      proofs.pinned.config.sha256 === proofs.reference.config.sha256 &&
      proofs.pinned.files.sha256 === proofs.reference.files.sha256;
    parity.push({ graph: graph.name, equal, proofs });
    dump("input-parity.json", parity);
    assert(equal, "Different compiler inputs for " + graph.name);
    for (const mode of modesFor(graph)) {
      for (let iteration = 1; iteration <= repeats; iteration++) {
        // Rotate each compiler through first/middle/last over three repetitions.
        const start = (iteration + group) % compilers.length;
        const order = [...compilers.slice(start), ...compilers.slice(0, start)];
        for (const compiler of order) {
          await measure(graph, compiler, mode, iteration);
        }
      }
    }
  }
  console.log(
    "Collected " +
      records.length +
      " samples for " +
      graphs.length +
      " canonical graphs and " +
      canaries.length +
      (memoryTarget
        ? " canaries. Memory diagnostic only; these traces cannot qualify a compiler."
        : " canaries. Run audit-compiler-comparison.mts before interpreting timings."),
  );
}
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[compiler-comparison] FAILED (exit 1)");
  process.exitCode = 1;
}
