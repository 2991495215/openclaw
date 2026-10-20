// Temporary SDK-only reproduction probe; it does not build or qualify the app.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  androidReleaseCommandFacts,
  androidReleaseConsoleLineFacts,
  androidReleaseHostFacts,
} from "./lib/android-release-e2e-diagnostics.ts";

const sdk = process.env.ANDROID_SDK_ROOT;
const output = process.env.PROOF_PATH;
if (process.platform !== "linux" || process.arch !== "x64" || !sdk || !output) {
  throw new Error("Requires Linux x64, ANDROID_SDK_ROOT and PROOF_PATH");
}
const root = await mkdtemp(path.join(os.tmpdir(), "android-adb-probe-"));
const env = {
  ...process.env,
  ANDROID_AVD_HOME: path.join(root, "avd"),
  ANDROID_USER_HOME: path.join(root, "android"),
};
await Promise.all([mkdir(env.ANDROID_AVD_HOME), mkdir(env.ANDROID_USER_HOME)]);
const adb = path.join(sdk, "platform-tools/adb");
const emulator = path.join(sdk, "emulator/emulator");
const filter = "adbd:V libc:F DEBUG:V init:I tombstoned:I lmkd:I *:S";
const run = promisify(execFile);
const started = Date.now();
let stage = "sdk";
const events: Record<string, unknown>[] = [];
const proof = {
  schema: 1,
  status: "failed",
  coverage:
    "two fresh phone emulators; 100 recursive directory pulls each; concurrent idle ADB shell",
  exclusions: [
    "app",
    "instrumentation",
    "Wear",
    "Gateway",
    "store upload",
    "app-scoped storage",
    "shared-storage/FUSE",
  ],
  targetSha: process.env.TARGET_SHA,
  iterations: 0,
  cleanupConfirmed: true,
  events,
};
function record(kind: string, facts: Record<string, unknown>) {
  events.push({ kind, stage, elapsedMs: Date.now() - started, ...facts });
}
async function command(bin: string, args: string[], timeout = 20_000, input?: string) {
  try {
    const pending = run(bin, args, { env, timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    pending.child.stdin?.end(input);
    return await pending;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    record("command-failed", {
      ...androidReleaseCommandFacts(bin, args, failure.stdout ?? "", failure.stderr ?? ""),
      code: typeof failure.code === "number" ? failure.code : null,
      killed: failure.killed === true,
      shellVerb:
        args[2] === "shell" &&
        ["dd", "stat", "sha256sum", "mkdir", "getprop"].includes(args[3] ?? "")
          ? args[3]
          : undefined,
      syncErrors: [
        "failed to read copy response: EOF",
        "failed to read copy response",
        "failed to read reason",
        "couldn't create file",
        "fchown() failed",
        "secure_mkdirs() failed",
        "decompress failed",
        "remote open failed",
        "remote read failed",
        "remote compress failed",
        "unexpected ID_DONE",
        "msg.data.size too large",
        "Transport endpoint is not connected",
        "Stale file handle",
        "Operation not permitted",
        "Read-only file system",
        "Bad file descriptor",
        "Invalid argument",
        "Input/output error",
        "Connection reset by peer",
        "Broken pipe",
      ].filter((message) => failure.stderr?.includes(message)),
    });
    throw new Error("probe-command-failed", { cause: error });
  }
}
type Owned = { child: ChildProcess; done: Promise<void>; stopped: boolean; label: string };
function service(label: string, bin: string, args: string[], log: string): Owned {
  const fd = openSync(log, "w", 0o600);
  const child = spawn(bin, args, { env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const owned: Owned = { child, done: Promise.resolve(), stopped: false, label };
  owned.done = new Promise<void>((resolve) => {
    child.on("error", () => record("service-spawn-error", { label }));
    child.once("close", (code, signal) => {
      record("service-exit", { label, code, signal, intentional: owned.stopped });
      resolve();
    });
  });
  return owned;
}
function groupAlive(owned: Owned) {
  if (!owned.child.pid) {
    return false;
  }
  try {
    process.kill(-owned.child.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
async function stop(owned: Owned) {
  owned.stopped = true;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (groupAlive(owned)) {
      process.kill(-owned.child.pid!, signal);
    }
    const deadline = Date.now() + 5000;
    while (groupAlive(owned) && Date.now() < deadline) {
      await sleep(100);
    }
  }
  const joined = await Promise.race([owned.done.then(() => true), sleep(1000).then(() => false)]);
  if (!joined || groupAlive(owned)) {
    proof.cleanupConfirmed = false;
  }
}
function running(owned: Owned) {
  return (
    owned.child.pid !== undefined &&
    owned.child.exitCode === null &&
    owned.child.signalCode === null
  );
}
async function snapshot(serial: string, cycle: number, moment: string) {
  const processes = await command("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="]);
  const meminfo = await readFile("/proc/meminfo", "utf8");
  const memoryEvents = await readFile("/sys/fs/cgroup/memory.events", "utf8").catch(() => "");
  record("host", {
    cycle,
    moment,
    ...androidReleaseHostFacts(processes.stdout, meminfo, memoryEvents),
  });
  const state = await command(adb, ["-s", serial, "get-state"]).catch(() => null);
  const pid = await command(adb, ["-s", serial, "shell", "pidof", "adbd"]).catch(() => null);
  record("device", {
    cycle,
    moment,
    online: state?.stdout.trim() === "device",
    adbdPid: /^\d+\s*$/u.test(pid?.stdout ?? "") ? Number(pid!.stdout.trim()) : null,
  });
}
async function consoleFacts(file: string, source: string, cycle: number) {
  const text = await readFile(file, "utf8").catch(() => "");
  record("console-capture", { cycle, source, bytes: Buffer.byteLength(text) });
  let adbdCrash = false;
  for (const line of text.split(/\r?\n/u)) {
    const facts = androidReleaseConsoleLineFacts(line);
    if (!facts) {
      continue;
    }
    if (facts.event === "native-crash") {
      adbdCrash = facts.process === "adbd";
    }
    if (facts.event === "native-frame" && (source !== "logcat" || !adbdCrash)) {
      continue;
    }
    record("console", {
      cycle,
      source,
      ...facts,
      collectedAfterCleanup: true,
      guestTime: /(?:^|\s)(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3,6})(?:\s|$)/u.exec(line)?.[1],
    });
  }
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
try {
  for (const [label, bin, args, pattern] of [
    ["platform-tools", adb, ["version"], /Version ([\d.-]+)/u],
    [
      "emulator",
      emulator,
      ["-no-window", "-version"],
      /emulator version ([\d.]+).*build_id (\d+)/u,
    ],
  ] as const) {
    const result = await command(bin, [...args]);
    const match = pattern.exec(result.stdout + result.stderr);
    record("sdk", { label, version: match?.[1], build: match?.[2] });
  }
  const imageMetadata = await readFile(
    path.join(sdk, "system-images/android-36/google_apis/x86_64/package.xml"),
  );
  record("system-image", { packageXmlSha256: digest(imageMetadata) });
  for (let cycle = 1; cycle <= 2; cycle++) {
    const name = `directory-probe-${cycle}`;
    const port = 5580 + (cycle - 1) * 2;
    const serial = `emulator-${port}`;
    const kernel = path.join(root, `${cycle}-kernel.private.log`);
    const logcat = path.join(root, `${cycle}-logcat.private.log`);
    const services: Owned[] = [];
    try {
      stage = "avd-create";
      await command(
        path.join(sdk, "cmdline-tools/latest/bin/avdmanager"),
        [
          "create",
          "avd",
          "--name",
          name,
          "--package",
          "system-images;android-36;google_apis;x86_64",
          "--device",
          "pixel_6",
        ],
        60_000,
        "no\n",
      );
      stage = "boot";
      const phone = service(
        "phone",
        emulator,
        [
          "-avd",
          name,
          "-port",
          String(port),
          "-no-window",
          "-no-audio",
          "-no-boot-anim",
          "-no-snapshot",
          "-gpu",
          "swiftshader",
          "-cores",
          "2",
          "-memory",
          "2048",
          "-show-kernel",
          "-logcat",
          filter,
          "-logcat-output",
          logcat,
        ],
        kernel,
      );
      services.push(phone);
      const deadline = Date.now() + 180_000;
      let booted = false;
      while (Date.now() < deadline && running(phone)) {
        const result = await command(
          adb,
          ["-s", serial, "shell", "getprop", "sys.boot_completed"],
          5000,
        ).catch(() => null);
        if (result?.stdout.trim() === "1") {
          booted = true;
          break;
        }
        await sleep(1000);
      }
      if (!booted) {
        throw new Error("boot-failed");
      }
      stage = "guest-diagnostics";
      const identity = await command(adb, ["-s", serial, "emu", "avd", "name"]);
      if (!identity.stdout.split(/\r?\n/u).includes(name)) {
        throw new Error("emulator-identity-mismatch");
      }
      const configured = await command(adb, ["-s", serial, "shell", "getprop", "ro.boot.logcat"]);
      const logService = await command(adb, [
        "-s",
        serial,
        "shell",
        "getprop",
        "init.svc.goldfish-logcat",
      ]);
      if (
        configured.stdout.trim() !== filter.replaceAll(" ", ",") ||
        logService.stdout.trim() !== "running"
      ) {
        throw new Error("guest-logging-unavailable");
      }
      stage = "fixture-setup";
      const remote = "/data/local/tmp/directory-probe";
      await command(adb, ["-s", serial, "shell", "mkdir", "-p", remote]);
      const expected = new Map<string, string>();
      for (let index = 0; index < 3; index++) {
        const file = `screenshot-${index}.png`;
        const size = index === 2 ? 165839 : 166000;
        // Screenshots originate in the guest. Avoid introducing a host-to-guest transfer.
        await command(adb, [
          "-s",
          serial,
          "shell",
          "dd",
          "if=/dev/urandom",
          `of=${remote}/${file}`,
          `bs=${size}`,
          "count=1",
        ]);
        const stat = await command(adb, [
          "-s",
          serial,
          "shell",
          "stat",
          "-c",
          "%s",
          `${remote}/${file}`,
        ]);
        const sha = await command(adb, ["-s", serial, "shell", "sha256sum", `${remote}/${file}`]);
        const hash = /^([a-f0-9]{64})\s/u.exec(sha.stdout)?.[1];
        if (Number(stat.stdout.trim()) !== size || !hash) {
          throw new Error("fixture-invalid");
        }
        expected.set(file, hash);
      }
      stage = "idle-shell";
      const idleLog = path.join(root, `${cycle}-idle.private.log`);
      const idle = service(
        "idle-shell",
        adb,
        ["-s", serial, "shell", "echo ready; sleep 900"],
        idleLog,
      );
      services.push(idle);
      const readyDeadline = Date.now() + 5000;
      while ((await readFile(idleLog, "utf8")).trim() !== "ready") {
        if (!running(idle) || Date.now() >= readyDeadline) {
          throw new Error("idle-shell-not-ready");
        }
        await sleep(100);
      }
      await snapshot(serial, cycle, "before-pulls");
      stage = "pull";
      for (let iteration = 1; iteration <= 100; iteration++) {
        const destination = path.join(root, "pulled");
        await mkdir(destination);
        const pullStarted = Date.now();
        await command(adb, ["-s", serial, "pull", `${remote}/.`, destination]);
        if (!running(phone) || !running(idle)) {
          throw new Error("concurrent-service-exit");
        }
        const files = await readdir(destination);
        if (files.length !== expected.size) {
          throw new Error("file-count-mismatch");
        }
        for (const file of files) {
          if (digest(await readFile(path.join(destination, file))) !== expected.get(file)) {
            throw new Error("file-hash-mismatch");
          }
        }
        proof.iterations++;
        record("pull", {
          cycle,
          iteration,
          durationMs: Date.now() - pullStarted,
          files: files.length,
          verified: true,
        });
        await rm(destination, { recursive: true });
        await sleep(100);
      }
      await snapshot(serial, cycle, "after-pulls");
    } catch (error) {
      // Observe recovery without restarting ADB or retrying the failed operation.
      const reasons = [
        "probe-command-failed",
        "boot-failed",
        "emulator-identity-mismatch",
        "guest-logging-unavailable",
        "fixture-invalid",
        "idle-shell-not-ready",
        "concurrent-service-exit",
        "file-count-mismatch",
        "file-hash-mismatch",
      ];
      record("cycle-failed", {
        cycle,
        reason:
          error instanceof Error && reasons.includes(error.message) ? error.message : "probe-error",
      });
      await snapshot(serial, cycle, "failure").catch(() => {});
      await command(adb, ["-s", serial, "wait-for-device"], 20_000).catch(() => null);
      await snapshot(serial, cycle, "after-passive-wait").catch(() => {});
      throw new Error("cycle-failed", { cause: error });
    } finally {
      for (const owned of services.toReversed()) {
        await stop(owned).catch(() => {
          proof.cleanupConfirmed = false;
        });
      }
      await consoleFacts(kernel, "kernel", cycle);
      await consoleFacts(logcat, "logcat", cycle);
    }
  }
  proof.status = proof.cleanupConfirmed ? "passed" : "failed";
} catch {
  proof.status = "failed";
} finally {
  await writeFile(output, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: proof.status,
      iterations: proof.iterations,
      cleanupConfirmed: proof.cleanupConfirmed,
    }),
  );
  if (proof.cleanupConfirmed) {
    await rm(root, { recursive: true, force: true });
  }
  if (proof.status !== "passed") {
    process.exitCode = 1;
  }
}
