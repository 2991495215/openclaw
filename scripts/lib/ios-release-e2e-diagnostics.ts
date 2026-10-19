import { execFile } from "node:child_process";
import { availableParallelism, freemem, loadavg, platform, totalmem } from "node:os";
import { stripVTControlCharacters } from "node:util";

type GatewayLogEvent = {
  event: string;
  durationMs?: number;
  queueDepth?: number;
  waitMs?: number;
  overdueMs?: number;
  elapsedMs?: number;
  pending?: Record<string, boolean>;
};

export function summarizeChatDeliveryLogs(text: string) {
  const stages = new Set([
    "agent-event-assistant",
    "agent-event-lifecycle",
    "chat-event-aborted",
    "chat-event-delta",
    "chat-event-error",
    "chat-event-final",
    "chat-event-other",
    "chat-event-session-mismatch",
    "chat-event-status",
    "delivery-unconfirmed",
    "draft-captured",
    "draft-rejected",
    "draft-validation-stopped",
    "event-reconnected",
    "event-route-changed",
    "event-sequence-gap",
    "health-lost",
    "health-recovered",
    "model-unavailable",
    "offline-outbox",
    "optimistic-message",
    "ordered-outbox",
    "outbox-accepted",
    "outbox-rejected",
    "owner-hydration-deferred",
    "owner-replaced",
    "route-changed",
    "send-failed",
    "send-invoked",
    "session-changed",
    "settings-failed",
    "settings-ready",
    "settings-wait",
    "transport-accepted",
    "transport-ack-error",
    "transport-ack-ok",
    "transport-ack-other",
    "transport-ack-started",
    "transport-ack-timeout",
    "transport-error-cancelled",
    "transport-error-decode",
    "transport-error-gateway-forbidden",
    "transport-error-gateway-invalid-request",
    "transport-error-gateway-other",
    "transport-error-gateway-unavailable",
    "transport-error-other",
    "transport-error-timeout",
    "transport-request-start",
    "transport-response-received",
    "transport-route-changed",
    "transport-route-ready",
    "transport-route-unavailable",
    "transport-route-wait",
    "transport-settings-unsupported",
    "transport-start",
  ]);
  const events: { stage: string; elapsedMs: number }[] = [];
  let firstTimestamp: number | undefined;
  for (const line of text.slice(-128 * 1024).split("\n")) {
    const match =
      /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\] qualification\.chat stage=([a-z-]+)$/u.exec(
        line,
      );
    const timestampText = match?.[1];
    const stage = match?.[2];
    if (!timestampText || !stage || !stages.has(stage)) {
      continue;
    }
    const timestamp = Date.parse(timestampText);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    firstTimestamp ??= timestamp;
    events.push({ stage, elapsedMs: timestamp - firstTimestamp });
  }
  return events.slice(-128);
}

export function summarizeGatewayLanes(value: unknown) {
  if (!value || typeof value !== "object") {
    return { outcome: "unavailable" as const };
  }
  const fields = value as Record<string, unknown>;
  const count = (input: unknown) =>
    typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : 0;
  const rows = (input: unknown): Record<string, unknown>[] =>
    Array.isArray(input)
      ? input
          .slice(0, 100)
          .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
      : [];
  const lanes = rows(fields.lanes);
  const dynamic = rows([fields.dynamic])[0];
  return {
    outcome: "captured" as const,
    workerCount: count(fields.workerCount),
    workerPoolCount: count(fields.workerPoolCount),
    pooledWorkerCount: rows(fields.workerPools).reduce(
      (sum, row) => sum + count(row.workerCount),
      0,
    ),
    activeCount: lanes.reduce((sum, row) => sum + count(row.activeCount), 0),
    queuedCount: lanes.reduce((sum, row) => sum + count(row.queuedCount), 0),
    maxConcurrent: lanes.reduce((sum, row) => sum + count(row.maxConcurrent), 0),
    drainingLaneCount: lanes.filter((row) => row.draining === true).length,
    ...(dynamic
      ? {
          dynamic: {
            laneCount: count(dynamic.laneCount),
            activeCount: count(dynamic.activeCount),
            queuedCount: count(dynamic.queuedCount),
            queuedLaneCount: count(dynamic.queuedLaneCount),
          },
        }
      : {}),
  };
}

// Diagnostic artifacts carry only these projections, never fixture logs or command output.
export function summarizeGatewayLogs(text: string): GatewayLogEvent[] {
  const events: GatewayLogEvent[] = [];
  for (const line of stripVTControlCharacters(text.slice(-128 * 1024)).split("\n")) {
    const rpc =
      /\b(req|res)\s+(?:[✓✗]\s+)?device\.pair\.(setupStatus|setupCode)\b(?:\s+(\d+)ms)?/u.exec(
        line,
      );
    if (rpc) {
      events.push({
        event: `${rpc[2] === "setupStatus" ? "setup-status" : "setup-code"}-${rpc[1] === "req" ? "received" : "responded"}`,
        ...(rpc[3] ? { durationMs: Number(rpc[3]) } : {}),
      });
    }
    if (line.includes("SQLite worker admission delayed")) {
      const fields: GatewayLogEvent = { event: "sqlite-worker-admission-delayed" };
      for (const key of ["queueDepth", "waitMs"] as const) {
        const value = new RegExp(`\\b${key}["']?\\s*[:=]\\s*(\\d+)`, "u").exec(line)?.[1];
        if (value) {
          fields[key] = Number(value);
        }
      }
      events.push(fields);
    }
    if (line.includes("memory pressure: level=critical")) {
      events.push({ event: "memory-critical" });
    }
    const delayedHeartbeat = /liveness heartbeat delayed: overdue=(\d+)ms elapsed=(\d+)ms/u.exec(
      line,
    );
    if (delayedHeartbeat) {
      events.push({
        event: "liveness-heartbeat-delayed",
        overdueMs: Number(delayedHeartbeat[1]),
        elapsedMs: Number(delayedHeartbeat[2]),
      });
    }
    const markers = [
      ["Idle shared-state worker retirement failed", "state-worker-idle-retirement-failed"],
      ["Shared-state worker retirement failed", "state-worker-retirement-failed"],
      ["service child cleanup identity lost:", "process-cleanup-identity-lost"],
      [
        "gateway process cleanup could not verify termination and output closure",
        "gateway-cleanup-unconfirmed",
      ],
      [
        "service child relay required forced retirement; cleanup completed",
        "process-cleanup-forced-retirement-completed",
      ],
    ] as const;
    for (const [marker, event] of markers) {
      if (line.includes(marker)) {
        events.push({ event });
      }
    }
    if (line.includes("service child cleanup did not complete before its hard deadline")) {
      const pending: Record<string, boolean> = {};
      for (const key of [
        "closingReceipt",
        "controlClose",
        "relayExit",
        "lineageEof",
        "extinctionUnconfirmed",
        "stdoutEnd",
        "stderrEnd",
      ]) {
        const value = new RegExp(`"${key}"\\s*:\\s*(true|false)`, "u").exec(line)?.[1];
        if (value) {
          pending[key] = value === "true";
        }
      }
      events.push({ event: "process-cleanup-deadline", pending });
    }
  }
  return events.slice(-32);
}

function observe(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 3_500, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

function summarizeSample(text: string) {
  const frameCounts = { sqlite: 0, filesystem: 0, locks: 0, poll: 0, v8: 0, node: 0, other: 0 };
  let frameCount = 0;
  for (const line of text.split("\n")) {
    if (!/^\s*[+!|:\s]*\d+\s+.+\(in /u.test(line)) {
      continue;
    }
    frameCount++;
    if (/sqlite/iu.test(line)) {
      frameCounts.sqlite++;
    } else if (/\b(?:read|write|pread|pwrite|open|stat|fsync|fcntl)|uv__fs/iu.test(line)) {
      frameCounts.filesystem++;
    } else if (/mutex|semaphore|ulock|condition|pthread_cond|__psynch/iu.test(line)) {
      frameCounts.locks++;
    } else if (/kevent|epoll|uv__io_poll|mach_msg/iu.test(line)) {
      frameCounts.poll++;
    } else if (/v8::|Builtin_|InterpreterEntry|Compile/iu.test(line)) {
      frameCounts.v8++;
    } else if (/node::|\(in node\)/iu.test(line)) {
      frameCounts.node++;
    } else {
      frameCounts.other++;
    }
  }
  return { outcome: "captured" as const, frameCount, frameCounts };
}

function summarizeMemory(vm: string | undefined, swap: string | undefined) {
  const pageSize = Number(/page size of (\d+) bytes/u.exec(vm ?? "")?.[1]);
  const pages: Record<string, number> = {};
  for (const [label, key] of [
    ["Pages free", "freeBytes"],
    ["Pages active", "activeBytes"],
    ["Pages inactive", "inactiveBytes"],
    ["Pages wired down", "wiredBytes"],
    ["Pages occupied by compressor", "compressorBytes"],
    ["Pageouts", "pageoutBytes"],
    ["Swapins", "swapinBytes"],
    ["Swapouts", "swapoutBytes"],
  ] as const) {
    const count = new RegExp(`^${label}:\\s+(\\d+)\\.`, "mu").exec(vm ?? "")?.[1];
    if (count && Number.isSafeInteger(pageSize) && pageSize > 0) {
      pages[key] = Number(count) * pageSize;
    }
  }
  const swapUsed = /\bused = (\d+(?:\.\d+)?)([KMG])\b/u.exec(swap ?? "");
  return {
    outcome: vm ? "captured" : "unavailable",
    ...pages,
    ...(swapUsed?.[1] && swapUsed[2]
      ? { swapUsedBytes: Number(swapUsed[1]) * 1024 ** ("KMG".indexOf(swapUsed[2]) + 1) }
      : {}),
  };
}

function summarizeWorkloads(output: string | undefined, gatewayPid: number) {
  if (!output) {
    return { outcome: "unavailable" };
  }
  const rows = output.split("\n").flatMap((line) => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+([A-Z][A-Za-z+<>-]*)\s+(.+)$/u.exec(line);
    const [, pid, parent, cpu, rss, state, command] = match ?? [];
    if (!pid || !parent || !cpu || !rss || !state || !command) {
      return [];
    }
    return [
      {
        pid: Number(pid),
        parent: Number(parent),
        cpu: Number(cpu),
        rss: Number(rss) * 1024,
        state: state.charAt(0),
        command,
      },
    ];
  });
  const gatewayTree = new Set([gatewayPid]);
  for (let previous = -1; previous !== gatewayTree.size;) {
    previous = gatewayTree.size;
    for (const row of rows) {
      if (gatewayTree.has(row.parent)) {
        gatewayTree.add(row.pid);
      }
    }
  }
  const groups: Record<
    string,
    { count: number; cpuPercent: number; rssBytes: number; runnable: number }
  > = {};
  for (const row of rows) {
    const group = gatewayTree.has(row.pid)
      ? "gateway"
      : /CoreSimulator|Simulator\.app|SimulatorTrampoline|OpenClaw\.app/u.test(row.command)
        ? "simulator"
        : /xcodebuild|XCTRunner|testmanagerd|SimulatorBridge/u.test(row.command)
          ? "testing"
          : /(?:^|\/)node(?:$|\s)/u.test(row.command)
            ? "other-node"
            : "other";
    const totals = (groups[group] ??= { count: 0, cpuPercent: 0, rssBytes: 0, runnable: 0 });
    totals.count++;
    totals.cpuPercent += row.cpu;
    totals.rssBytes += row.rss;
    totals.runnable += row.state === "R" ? 1 : 0;
  }
  // RSS sums can include shared pages; they are workload attribution, not physical footprint.
  return { outcome: "captured", groups };
}

export async function collectGatewayProcessDiagnostics(
  pid?: number,
  options: { sample?: boolean } = {},
) {
  const host = {
    cpuCount: availableParallelism(),
    freeMemoryBytes: freemem(),
    totalMemoryBytes: totalmem(),
    loadAverage: loadavg(),
  };
  const validPid = Number.isSafeInteger(pid) && pid !== undefined && pid > 0;
  const macResources = validPid && platform() === "darwin";
  const [processOutput, sampleOutput, vmOutput, swapOutput, workloadsOutput] = await Promise.all([
    validPid ? observe("/bin/ps", ["-p", String(pid), "-o", "%cpu=,rss=,state="]) : undefined,
    validPid && options.sample && platform() === "darwin"
      ? observe("/usr/bin/sample", [String(pid), "1", "1", "-file", "/dev/stdout"])
      : undefined,
    macResources ? observe("/usr/bin/vm_stat", []) : undefined,
    macResources ? observe("/usr/sbin/sysctl", ["vm.swapusage"]) : undefined,
    macResources ? observe("/bin/ps", ["-axo", "pid=,ppid=,%cpu=,rss=,state=,comm="]) : undefined,
  ]);
  const fields = processOutput?.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+)\s+([A-Z][A-Za-z+<>-]*)$/u);
  const state = fields?.[3]?.[0];
  return {
    host,
    ...(macResources
      ? {
          memory: summarizeMemory(vmOutput, swapOutput),
          workloads: summarizeWorkloads(workloadsOutput, pid),
        }
      : {}),
    process: fields
      ? {
          outcome: "captured" as const,
          cpuPercent: Number(fields[1]),
          rssBytes: Number(fields[2]) * 1024,
          // Only the primary BSD process state matters; flags and text are discarded.
          state: state && ["I", "R", "S", "T", "U", "Z"].includes(state) ? state : "other",
        }
      : { outcome: "unavailable" as const },
    ...(options.sample
      ? {
          sample: sampleOutput
            ? summarizeSample(sampleOutput)
            : { outcome: "unavailable" as const },
        }
      : {}),
  };
}
