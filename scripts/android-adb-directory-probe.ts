// Temporary SDK-only reproduction probe; it does not build or qualify the app.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  androidAdbKernelCapture,
  androidAdbKernelWrites,
} from "./lib/android-adb-kernel-diagnostics.ts";
import {
  androidReleaseAdbBridgeLineFacts,
  androidReleaseAdbGuestSocketFacts,
  androidReleaseAdbServerLineFacts,
  androidReleaseAdbSocketPair,
  androidReleaseAdbSyscallLineFacts,
  androidReleaseAdbdLineFacts,
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
const adbLog = path.join(root, "adb-server.private.log");
const env = {
  ...process.env,
  ANDROID_ADB_LOG_PATH: adbLog,
  ADB_TRACE: "",
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
let adbLogLines = 0;
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
  startedAt: new Date(started).toISOString(),
  iterations: 0,
  cleanupConfirmed: true,
  events,
};
function record(kind: string, facts: Record<string, unknown>) {
  events.push({ kind, stage, elapsedMs: Date.now() - started, ...facts });
}
async function command(
  bin: string,
  args: string[],
  timeout = 20_000,
  input?: string,
  maxBuffer = 1024 * 1024,
) {
  try {
    const pending = run(bin, args, { env, timeout, killSignal: "SIGKILL", maxBuffer });
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
type Owned = {
  child: ChildProcess;
  done: Promise<void>;
  stopped: boolean;
  label: string;
  privileged: boolean;
  bridge?: { log: string; pid: number; cycle: number };
};
function service(
  label: string,
  bin: string,
  args: string[],
  log: string,
  privileged = false,
): Owned {
  const fd = openSync(log, "w", 0o600);
  const child = spawn(bin, args, { env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const owned: Owned = { child, done: Promise.resolve(), stopped: false, label, privileged };
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
    if (owned.privileged && (error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    throw error;
  }
}
async function stop(owned: Owned) {
  owned.stopped = true;
  if (owned.bridge) {
    const installed = (await bridgeFacts(owned.bridge.log)).find(
      (fact) => fact.event === "installed",
    );
    if (installed && running(owned)) {
      const status = await readFile(`/proc/${owned.bridge.pid}/status`, "utf8").catch(() => "");
      if (Number(/^TracerPid:\s+(\d+)/mu.exec(status)?.[1]) === installed.gdbPid) {
        // Signal GDB itself: signalling sudo's group can forward the interrupt twice.
        await command("sudo", ["-n", "kill", "-SIGINT", "--", String(installed.gdbPid)]).catch(
          () => {
            proof.cleanupConfirmed = false;
          },
        );
        await Promise.race([owned.done, sleep(5000)]);
      }
    }
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (groupAlive(owned)) {
      if (owned.privileged) {
        await command("sudo", ["-n", "kill", `-${signal}`, "--", String(-owned.child.pid!)]);
      } else {
        process.kill(-owned.child.pid!, signal);
      }
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
  if (owned.bridge) {
    const facts = await bridgeFacts(owned.bridge.log);
    for (const fact of facts) {
      record("bridge-trace", { cycle: owned.bridge.cycle, ...fact });
    }
    const status = await readFile(`/proc/${owned.bridge.pid}/status`, "utf8").catch(() => "");
    const detached = facts.some((fact) => fact.event === "detached");
    const tracerReleased = /^TracerPid:\s+0$/mu.test(status);
    record("bridge-detach", { cycle: owned.bridge.cycle, detached, tracerReleased });
    if (!detached || !tracerReleased) {
      proof.cleanupConfirmed = false;
    }
  }
}
async function bridgeFacts(file: string) {
  return (await readFile(file, "utf8").catch(() => "")).split("\n").flatMap((line) => {
    const fact = androidReleaseAdbBridgeLineFacts(line);
    return fact ? [fact] : [];
  });
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
    const adbd = source === "logcat" ? androidReleaseAdbdLineFacts(line) : undefined;
    if (adbd) {
      record("guest-adbd", {
        cycle,
        ...adbd,
        guestTime: /(?:^|\s)(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3,6})(?:\s|$)/u.exec(line)?.[1],
        collectedAfterCleanup: true,
      });
    }
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
async function adbServerFacts(cycle: number, moment: string) {
  const text = await readFile(adbLog, "utf8").catch(() => null);
  record("adb-server-capture", {
    cycle,
    moment,
    available: text !== null,
    bytes: text === null ? 0 : Buffer.byteLength(text),
  });
  if (!text) {
    return false;
  }
  const lines = text.split(/\r?\n/u);
  // Keep a partial final record for the next capture while the server is writing.
  lines.pop();
  for (const line of lines.slice(adbLogLines)) {
    const facts = androidReleaseAdbServerLineFacts(line);
    if (facts && (facts.port === 5580 || facts.port === 5582)) {
      record("adb-server", { cycle, moment, ...facts });
    }
  }
  adbLogLines = lines.length;
  return true;
}
async function processSockets(pid: number) {
  const sockets = [];
  // The emulator also launches short-lived ADB clients in its process group.
  const files = await readdir(`/proc/${pid}/fd`).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  for (const file of files) {
    const target = await readlink(`/proc/${pid}/fd/${file}`).catch(() => "");
    const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1];
    if (inode) {
      sockets.push({ pid, fd: Number(file), inode });
    }
  }
  return sockets;
}
async function transportSockets(port: number, phone: Owned) {
  const processes = await command("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="]);
  const servers = androidReleaseHostFacts(processes.stdout, "", "").adbProcesses.filter(
    (process) => process.parentPid === 1,
  );
  if (servers.length !== 1) {
    throw new Error("adb-server-identity-unavailable");
  }
  const pid = servers[0]!.pid;
  if ((await readlink(`/proc/${pid}/exe`)) !== (await realpath(adb))) {
    throw new Error("adb-server-identity-unavailable");
  }
  const hostSockets = await processSockets(pid);
  const pairs = [];
  for (const family of ["tcp", "tcp6"]) {
    const table = await readFile(`/proc/${pid}/net/${family}`, "utf8");
    const pair = androidReleaseAdbSocketPair(
      table,
      hostSockets.map((socket) => socket.inode),
      port,
    );
    if (pair) {
      pairs.push(pair);
    }
  }
  if (pairs.length !== 1) {
    throw new Error("adb-transport-socket-unavailable");
  }
  const pair = pairs[0]!;
  const hosts = hostSockets.filter((socket) => socket.inode === pair.hostInode);
  const groups = await command("ps", ["-A", "-o", "pid=,pgid="]);
  const peers = [];
  for (const line of groups.stdout.trim().split("\n")) {
    const [processId, groupId] = line.trim().split(/\s+/u).map(Number);
    if (groupId === phone.child.pid) {
      peers.push(
        ...(await processSockets(processId!)).filter((socket) => socket.inode === pair.peerInode),
      );
    }
  }
  if (hosts.length !== 1 || peers.length !== 1) {
    throw new Error("adb-transport-peer-unavailable");
  }
  return [
    { side: "adb-server", ...hosts[0]!, port, clientPort: pair.clientPort },
    { side: "emulator", ...peers[0]!, port, clientPort: pair.clientPort },
  ];
}
async function syscallFacts(prefix: string, fd: number) {
  const facts = [];
  for (const file of await readdir(root)) {
    if (
      !file.startsWith(path.basename(prefix) + ".") ||
      !/^\d+$/u.test(file.slice(file.lastIndexOf(".") + 1))
    ) {
      continue;
    }
    const tid = Number(file.slice(file.lastIndexOf(".") + 1));
    for (const line of (await readFile(path.join(root, file), "utf8")).split("\n")) {
      const fact = androidReleaseAdbSyscallLineFacts(line);
      if (fact?.fd === fd) {
        facts.push({ ...fact, tid });
      }
    }
  }
  facts.sort((a, b) => a.startedAtSeconds - b.startedAtSeconds);
  // A reconnect can reuse this descriptor. Only attribute the original socket's lifetime.
  const closed = facts.find((fact) => fact.operation === "close" && fact.result === 0);
  return closed ? facts.filter((fact) => fact.startedAtSeconds <= closed.startedAtSeconds) : facts;
}
type GuestTrace = {
  sockets: NonNullable<ReturnType<typeof androidReleaseAdbGuestSocketFacts>>[];
  serial: string;
  pid: number;
  cycle: number;
  directory: string;
  prefix: string;
  tids: number[];
  started: boolean;
  tracerPid?: number;
};
type KernelTrace = { guest: GuestTrace; tid: number; fd: number; started: boolean };
const kernelHelper = "/data/local/tmp/openclaw-adb-kernel-probe.sh";
async function kernelCommand(trace: KernelTrace, action: "start" | "read" | "stop" | "cleanup") {
  try {
    const result = await guestRoot(
      trace.guest.serial,
      `sh ${kernelHelper} ${action} ${trace.tid} ${trace.fd}\n`,
      // The bounded binary trace ring expands when rendered as private text.
      4 * 1024 * 1024,
    );
    return { ...androidAdbKernelCapture(result.stdout, 1), completed: true };
  } catch (error) {
    // Preserve sanitized evidence even if a later sampler or cleanup check fails.
    const failure =
      error instanceof Error ? (error.cause as { stdout?: string } | undefined) : undefined;
    return { ...androidAdbKernelCapture(failure?.stdout ?? "", 1), completed: false };
  }
}
async function startKernelTrace(trace: KernelTrace) {
  await command(adb, [
    "-s",
    trace.guest.serial,
    "push",
    path.resolve("scripts/android-adb-kernel-probe.sh"),
    kernelHelper,
  ]);
  trace.started = true;
  const initial = await kernelCommand(trace, "start");
  record("guest-kernel-start", {
    cycle: trace.guest.cycle,
    tid: trace.tid,
    fd: trace.fd,
    ...initial,
  });
  if (!initial.completed || !initial.ready || initial.identity.arch !== "x86_64") {
    throw new Error("guest-kernel-prerequisite-failed");
  }
  await command(adb, ["-s", trace.guest.serial, "shell", "printf", "kernel-probe-ready"]);
  const captured = await kernelCommand(trace, "read");
  const writes = androidAdbKernelWrites(captured.events, trace.tid, trace.fd);
  const readyWrite = writes.find(
    (write) =>
      write.events.some((event) => event.event === "alloc_enter" && event.bytes > 0) &&
      write.events.some((event) => event.event === "alloc_return" && !event.isNull) &&
      write.events.some((event) => event.event === "packet_enter" && event.bytes > 0) &&
      write.events.some((event) => event.event === "packet_return" && !event.isNull) &&
      write.events.some((event) => event.event === "copy_enter" && event.bytes > 0) &&
      write.events.some((event) => event.event === "copy_return" && event.copiedBytes > 0) &&
      write.result > 0,
  );
  record("guest-kernel-ready", {
    cycle: trace.guest.cycle,
    traced: Boolean(readyWrite),
    write: readyWrite,
  });
  if (!captured.completed || !readyWrite) {
    throw new Error("guest-kernel-coverage-unavailable");
  }
}
async function stopKernelTrace(trace: KernelTrace) {
  if (!trace.started) {
    return;
  }
  try {
    const captured = await kernelCommand(trace, "stop");
    const writes = androidAdbKernelWrites(captured.events, trace.tid, trace.fd);
    record("guest-kernel-capture", {
      cycle: trace.guest.cycle,
      tid: trace.tid,
      fd: trace.fd,
      ...captured,
      events: undefined,
      records: captured.events.length,
      writes: writes.length,
      failedWrites: writes.filter((write) => write.result < 0),
      tail: captured.events.slice(-80),
    });
    if (!captured.completed) {
      throw new Error("guest-kernel-capture-incomplete");
    }
  } finally {
    const cleanup = await kernelCommand(trace, "cleanup");
    const cleaned = cleanup.completed && cleanup.cleaned;
    record("guest-kernel-cleanup", { cycle: trace.guest.cycle, cleaned });
    if (!cleaned) {
      proof.cleanupConfirmed = false;
    }
  }
}
const guestRoot = (serial: string, script: string, maxBuffer?: number) =>
  command(adb, ["-s", serial, "shell", "su", "0", "sh"], 20_000, script, maxBuffer);
async function prepareGuestTrace(serial: string, cycle: number): Promise<GuestTrace> {
  const uid = await command(adb, ["-s", serial, "shell", "su", "0", "id", "-u"]);
  const version = await command(adb, ["-s", serial, "shell", "/system/bin/strace", "-V"]);
  const daemon = await command(adb, ["-s", serial, "shell", "pidof", "adbd"]);
  const pid = /^\d+\s*$/u.test(daemon.stdout) ? Number(daemon.stdout.trim()) : 0;
  record("guest-trace-prerequisites", {
    cycle,
    root: uid.stdout.trim() === "0",
    version: /strace -- version ([\d.]+)/u.exec(version.stdout + version.stderr)?.[1],
    pid,
  });
  if (uid.stdout.trim() !== "0" || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("guest-trace-prerequisite-failed");
  }
  const status = await guestRoot(serial, `cat /proc/${pid}/status\n`);
  if (!/^TracerPid:\s+0$/mu.test(status.stdout)) {
    throw new Error("guest-trace-already-attached");
  }
  const helper = process.env.ANDROID_ADB_SOCKET_INSPECT;
  if (!helper) {
    throw new Error("guest-socket-helper-unavailable");
  }
  const remoteHelper = "/data/local/tmp/openclaw-adbd-socket-inspect";
  await command(adb, ["-s", serial, "push", helper, remoteHelper]);
  await command(adb, ["-s", serial, "shell", "chmod", "700", remoteHelper]);
  const inspected = await guestRoot(serial, `${remoteHelper} ${pid} || true\n`);
  const sockets = inspected.stdout.split(/\r?\n/u).flatMap((line) => {
    const socket = androidReleaseAdbGuestSocketFacts(line);
    return socket ? [socket] : [];
  });
  // adbd's emulator transport listens on vsock port 5555; exclude unrelated sockets.
  const candidates = sockets.filter((socket) => socket.localPort === 5555 && socket.peerCid === 2);
  record("guest-socket-discovery", {
    cycle,
    connectedSockets: sockets,
    candidates: candidates.length,
    helperErrno:
      Number(/^OPENCLAW_ADB_VSOCK_ERROR (\d+)$/mu.exec(inspected.stderr)?.[1]) || undefined,
  });
  if (candidates.length === 0) {
    throw new Error("guest-transport-socket-unavailable");
  }
  const tasks = await guestRoot(serial, `ls /proc/${pid}/task\n`);
  const tids = tasks.stdout.trim().split(/\s+/u).map(Number);
  if (!tids.length || !tids.every((tid) => Number.isSafeInteger(tid) && tid > 1)) {
    throw new Error("guest-trace-prerequisite-failed");
  }
  return {
    sockets: candidates,
    serial,
    pid,
    cycle,
    tids,
    directory: `/data/local/tmp/openclaw-adbd-trace-${cycle}`,
    prefix: path.join(root, `${cycle}-guest-syscalls.private`),
    started: false,
  };
}
async function startGuestTrace(guest: GuestTrace) {
  guest.started = true;
  await guestRoot(
    guest.serial,
    `
set -eu
umask 077
mkdir ${guest.directory}
setsid /system/bin/strace -ff -ttt -T -I 2 \\
  -e trace=read,readv,write,writev,recvfrom,recvmsg,sendto,sendmsg,shutdown,close \\
  -e raw=all -e signal=none -p ${guest.pid} -o ${guest.directory}/syscalls \\
  </dev/null >${guest.directory}/tracer.log 2>&1 &
echo $! >${guest.directory}/tracer.pid
`,
  );
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await guestRoot(guest.serial, `cat /proc/${guest.pid}/status\n`);
    const tracer = Number(/^TracerPid:\s+(\d+)$/mu.exec(status.stdout)?.[1]);
    const launched = await guestRoot(guest.serial, `cat ${guest.directory}/tracer.pid\n`);
    if (tracer > 1 && tracer === Number(launched.stdout.trim())) {
      guest.tracerPid = tracer;
      record("guest-trace-attached", {
        cycle: guest.cycle,
        pid: guest.pid,
        tracerPid: tracer,
        tids: guest.tids,
        sockets: guest.sockets,
      });
      return;
    }
    await sleep(100);
  }
  const diagnostic = await guestRoot(guest.serial, `cat ${guest.directory}/tracer.log\n`);
  record("guest-trace-attach-error", {
    cycle: guest.cycle,
    permissionDenied: /Operation not permitted|Permission denied/u.test(diagnostic.stdout),
    unsupportedOption: /invalid option|invalid argument|unrecognized option/u.test(
      diagnostic.stdout,
    ),
  });
  throw new Error("guest-trace-attach-failed");
}
async function guestSyscallFacts(guest: GuestTrace, sample = false) {
  // Only the original daemon threads own this transport. Followed shell children
  // have independent descriptor tables and can reuse the same descriptor number.
  // The shell-manager thread doing the initial task listing may exit before attach.
  for (const tid of guest.tids) {
    const captured = await guestRoot(
      guest.serial,
      `if [ -f ${guest.directory}/syscalls.${tid} ]; then ${sample ? "head -n 40" : "cat"} ${guest.directory}/syscalls.${tid}; fi\n`,
    );
    await writeFile(`${guest.prefix}.${tid}`, captured.stdout, { mode: 0o600 });
  }
  return Promise.all(
    guest.sockets.map(async (socket) => ({
      ...socket,
      facts: await syscallFacts(guest.prefix, socket.fd),
    })),
  );
}
async function stopGuestTrace(guest: GuestTrace) {
  if (!guest.started) {
    return;
  }
  // The tracer has its own session and guest-local output, surviving ADB loss.
  // Verify its task-owned PID and executable before sending the detach signal.
  const stopped = await guestRoot(
    guest.serial,
    `
set -eu
tracer=$(cat ${guest.directory}/tracer.pid)
case "$tracer" in ''|*[!0-9]*) exit 1;; esac
if [ -e /proc/$tracer/exe ]; then
  [ "$(readlink /proc/$tracer/exe)" = /system/bin/strace ]
  kill -INT "$tracer"
fi
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  attached=0
  for task in /proc/${guest.pid}/task/*; do
    if ! grep -q '^TracerPid:[[:space:]]*0$' "$task/status"; then attached=1; fi
  done
  if [ "$attached" = 0 ]; then echo detached; break; fi
  sleep 0.1
done
pidof adbd
`,
  );
  const detached = stopped.stdout.split(/\r?\n/u).includes("detached");
  const sameDaemon = stopped.stdout.trim().split(/\s+/u).at(-1) === String(guest.pid);
  record("guest-trace-detach", { cycle: guest.cycle, detached, sameDaemon });
  if (!detached || !sameDaemon) {
    throw new Error("guest-trace-detach-failed");
  }
  for (const { facts, ...socket } of await guestSyscallFacts(guest)) {
    record("transport-syscalls", {
      cycle: guest.cycle,
      side: "guest-adbd",
      pid: guest.pid,
      ...socket,
      available: true,
      records: facts.length,
      terminal: facts.filter(
        (fact) => fact.eof || fact.result < 0 || ["shutdown", "close"].includes(fact.operation),
      ),
      tail: facts.slice(-32),
    });
  }
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
try {
  for (const [label, bin, args, pattern] of [
    ["strace", "strace", ["--version"], /strace -- version ([\d.]+)/u],
    ["gdb", "gdb", ["--version"], /GNU gdb[^\n]* ([\d.]+)\n/u],
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
    let guest: GuestTrace | undefined;
    let kernelTrace: KernelTrace | undefined;
    let sockets: Awaited<ReturnType<typeof transportSockets>> = [];
    const tracePrefix = (side: string) => path.join(root, `${cycle}-${side}-syscalls.private`);
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
      if (!(await adbServerFacts(cycle, "before-pulls"))) {
        throw new Error("host-adb-log-unavailable");
      }
      stage = "syscall-trace";
      guest = await prepareGuestTrace(serial, cycle);
      await startGuestTrace(guest);
      const beforeGuestClock = Date.now();
      const guestClock = await guestRoot(serial, "date +%s.%N\n");
      record("guest-clock", {
        cycle,
        beforeHostSeconds: beforeGuestClock / 1000,
        afterHostSeconds: Date.now() / 1000,
        guestSeconds: /^\d+\.\d+\s*$/u.test(guestClock.stdout)
          ? Number(guestClock.stdout.trim())
          : null,
      });
      sockets = await transportSockets(port + 1, phone);
      const tracers = [];
      for (const socket of sockets) {
        record("transport-socket", { cycle, ...socket });
        if (socket.side === "emulator") {
          continue;
        }
        // Keep the host's raw syscall trace; GDB owns the emulator's ptrace attachment.
        const tracer = service(
          `${socket.side}-syscalls`,
          "sudo",
          [
            "-n",
            "strace",
            "-ff",
            "-ttt",
            "-T",
            "-e",
            "trace=read,write,writev,recvfrom,sendto,close,shutdown",
            "-e",
            "raw=all",
            "-e",
            "signal=none",
            "-o",
            tracePrefix(socket.side),
            "-p",
            String(socket.pid),
          ],
          path.join(root, `${cycle}-${socket.side}-strace.private.log`),
          true,
        );
        tracers.push(tracer);
        services.push(tracer);
      }
      const peer = sockets.find((socket) => socket.side === "emulator")!;
      const bridgeLog = path.join(root, `${cycle}-bridge.private.log`);
      const debuggerService = service(
        "emulator-bridge",
        "sudo",
        [
          "-n",
          "gdb",
          "--nx",
          "--nh",
          "--batch",
          "-iex",
          "set auto-load off",
          "-ex",
          `python probe_pid=${peer.pid}`,
          "-x",
          path.resolve("scripts/android-adb-bridge-trace.py"),
        ],
        bridgeLog,
        true,
      );
      debuggerService.bridge = { log: bridgeLog, pid: peer.pid, cycle };
      services.push(debuggerService);
      tracers.push(debuggerService);
      const traceDeadline = Date.now() + 30_000;
      let traced = false;
      let hostTraced = false;
      let bridgeTraced = false;
      while (tracers.every(running) && Date.now() < traceDeadline) {
        if (!(await bridgeFacts(bridgeLog)).some((fact) => fact.event === "installed")) {
          await sleep(100);
          continue;
        }
        // Exercise the one-shot bridge breakpoint before trusting the closure probes.
        await command(adb, ["-s", serial, "shell", "true"]);
        const host = sockets.find((socket) => socket.side === "adb-server")!;
        hostTraced = (await syscallFacts(tracePrefix(host.side), host.fd)).some(
          (fact) => fact.result > 0,
        );
        bridgeTraced = (await bridgeFacts(bridgeLog)).some((fact) => fact.event === "ready");
        if (hostTraced && bridgeTraced) {
          traced = true;
          break;
        }
        await sleep(100);
      }
      record("trace-ready", {
        cycle,
        traced,
        hostSyscalls: hostTraced,
        emulatorBridge: bridgeTraced,
      });
      if (!traced) {
        throw new Error("adb-syscall-trace-unavailable");
      }
      const guestSample = await guestSyscallFacts(guest, true);
      const guestTraced = guestSample.some(({ facts }) => facts.some((fact) => fact.result > 0));
      record("guest-trace-ready", { cycle, traced: guestTraced });
      if (!guestTraced) {
        throw new Error("guest-syscall-trace-unavailable");
      }
      const writers = guestSample.flatMap(({ fd, facts }) =>
        [
          ...new Set(
            facts
              .filter((fact) => fact.operation === "write" && fact.result > 0)
              .map((fact) => fact.tid),
          ),
        ].map((tid) => ({ fd, tid })),
      );
      if (writers.length !== 1) {
        throw new Error("guest-kernel-writer-unavailable");
      }
      kernelTrace = { guest, ...writers[0]!, started: false };
      stage = "kernel-trace";
      await startKernelTrace(kernelTrace);
      stage = "pull";
      for (let iteration = 1; iteration <= 100; iteration++) {
        const destination = path.join(root, "pulled");
        await mkdir(destination);
        const pullStarted = Date.now();
        await command(adb, ["-s", serial, "pull", `${remote}/.`, destination]);
        if (!running(phone) || !running(idle) || !tracers.every(running)) {
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
        "host-adb-log-unavailable",
        "adb-server-identity-unavailable",
        "adb-transport-socket-unavailable",
        "adb-transport-peer-unavailable",
        "adb-syscall-trace-unavailable",
        "guest-trace-prerequisite-failed",
        "guest-trace-already-attached",
        "guest-socket-helper-unavailable",
        "guest-transport-socket-unavailable",
        "guest-trace-attach-failed",
        "guest-syscall-trace-unavailable",
        "guest-kernel-writer-unavailable",
        "guest-kernel-prerequisite-failed",
        "guest-kernel-coverage-unavailable",
      ];
      record("cycle-failed", {
        cycle,
        reason:
          error instanceof Error && reasons.includes(error.message) ? error.message : "probe-error",
      });
      await snapshot(serial, cycle, "failure").catch(() => {});
      await adbServerFacts(cycle, "failure");
      await command(adb, ["-s", serial, "wait-for-device"], 20_000).catch(() => null);
      await snapshot(serial, cycle, "after-passive-wait").catch(() => {});
      await adbServerFacts(cycle, "after-passive-wait");
      throw new Error("cycle-failed", { cause: error });
    } finally {
      await adbServerFacts(cycle, "before-cleanup");
      if (kernelTrace) {
        await stopKernelTrace(kernelTrace).catch(() => {
          record("guest-kernel-capture-failed", { cycle });
          proof.cleanupConfirmed = false;
        });
      }
      if (guest) {
        await stopGuestTrace(guest).catch(() => {
          record("guest-trace-capture-failed", { cycle });
          proof.cleanupConfirmed = false;
        });
      }
      for (const socket of sockets) {
        if (socket.side !== "adb-server") {
          continue;
        }
        const facts = await syscallFacts(tracePrefix(socket.side), socket.fd).catch(() => null);
        record("transport-syscalls", {
          cycle,
          ...socket,
          available: facts !== null,
          records: facts?.length,
          // Keep every error/EOF plus the final operations leading to teardown.
          terminal: facts?.filter(
            (fact) => fact.eof || fact.result < 0 || ["shutdown", "close"].includes(fact.operation),
          ),
          tail: facts?.slice(-24),
        });
      }
      for (const owned of services.toReversed()) {
        await stop(owned).catch(() => {
          proof.cleanupConfirmed = false;
        });
      }
      await consoleFacts(kernel, "kernel", cycle);
      await consoleFacts(logcat, "logcat", cycle);
      await adbServerFacts(cycle, "after-cleanup");
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
