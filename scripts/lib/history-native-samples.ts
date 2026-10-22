import { readFileSync, readdirSync } from "node:fs";

export type HistoryNativeLifetime = {
  pid: number;
  parentPid: number;
  firstSeen: number;
  lastSeen: number;
  startTicks: string;
  command: string[];
  exitedObservedAt?: number;
};

/** PID lifecycle polling stays light; expensive mapping reads are explicit stage observations. */
export function sampleHistoryNativeTree(
  rootPid: number,
  processLifetimes: Map<number, HistoryNativeLifetime>,
  includeMemory = false,
) {
  const live = new Set<number>();
  const pendingPids = [rootPid];
  const samples = [];
  for (let pid; (pid = pendingPids.shift()) !== undefined;) {
    if (live.has(pid)) {
      continue;
    }
    try {
      const proc = "/proc/" + pid;
      const raw = readFileSync(proc + "/stat", "utf8");
      const fields = raw
        .slice(raw.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const command = readFileSync(proc + "/cmdline", "utf8").split("\0");
      const now = Date.now();
      live.add(pid);
      const prior = processLifetimes.get(pid);
      const lifetime = prior ?? {
        pid,
        parentPid: Number(fields[1]),
        firstSeen: now,
        lastSeen: now,
        startTicks: fields[19]!,
        command,
      };
      lifetime.lastSeen = now;
      processLifetimes.set(pid, lifetime);
      let memory: Record<string, number> = {};
      try {
        if (includeMemory) {
          memory = Object.fromEntries(
            readFileSync(proc + "/smaps_rollup", "utf8")
              .split("\n")
              .flatMap((line) => {
                const match =
                  /^(Rss|Pss|Private_Clean|Private_Dirty|Private_Hugetlb):\s+(\d+) kB/.exec(line);
                return match ? [[match[1]!, Number(match[2]) * 1024]] : [];
              }),
          );
        }
      } catch {
        /* A short-lived child can retire before the optional native sample. */
      }
      samples.push({
        pid,
        parentPid: lifetime.parentPid,
        startTicks: lifetime.startTicks,
        userTicks: Number(fields[11]),
        systemTicks: Number(fields[12]),
        memory,
      });
      for (const tid of readdirSync(proc + "/task")) {
        try {
          pendingPids.push(
            ...readFileSync(proc + "/task/" + tid + "/children", "utf8")
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .map(Number),
          );
        } catch {
          /* Native retirement is recorded at the next observation. */
        }
      }
    } catch {
      /* A child may exit during procfs traversal. */
    }
  }
  for (const lifetime of processLifetimes.values()) {
    if (!live.has(lifetime.pid)) {
      lifetime.exitedObservedAt ??= Date.now();
    }
  }
  return samples;
}
