export type AndroidAdbKernelEvent = { tid: number; timeSeconds: number } & (
  | { event: "sys_enter"; fd: number; bytes: number }
  | { event: "sys_exit"; result: number }
  | { event: "alloc_enter" | "packet_enter" | "copy_enter"; bytes: number }
  | { event: "alloc_return" | "packet_return"; isNull: boolean }
  | { event: "copy_return"; copiedBytes: number }
);

const integer = (value: string | undefined) => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Trace output stays private; export no task names, addresses, arguments, or payloads. */
export function androidAdbKernelLineFacts(
  line: string,
  writeSyscall: 1 | 64,
): AndroidAdbKernelEvent | undefined {
  const match =
    /^[^\r\n]*-(\d+)\s+(?:\(\s*\d+\)\s+)?\[\d+\]\s+\S+\s+(\d+\.\d+):\s+(\w+):\s+([^\r\n]*)$/u.exec(
      line,
    );
  if (!match) {
    return undefined;
  }
  const tid = integer(match[1]);
  const timeSeconds = Number(match[2]);
  if (!tid || !Number.isFinite(timeSeconds)) {
    return undefined;
  }
  const event = match[3]!;
  const body = match[4]!;
  const base = { tid, timeSeconds };
  if (event === "sys_enter") {
    // raw_syscalls prints the syscall ID in decimal and all six arguments in hex.
    const enter =
      /^NR (\d+) \(([a-f0-9]+), [a-f0-9]+, ([a-f0-9]+), [a-f0-9]+, [a-f0-9]+, [a-f0-9]+\)$/u.exec(
        body,
      );
    if (enter && Number(enter[1]) === writeSyscall) {
      const fd = integer(`0x${enter[2]}`);
      const bytes = integer(`0x${enter[3]}`);
      if (fd !== undefined && bytes !== undefined) {
        return { ...base, event, fd, bytes };
      }
    }
  } else if (event === "sys_exit") {
    const exit = /^NR (\d+) = (-?\d+)$/u.exec(body);
    if (exit && Number(exit[1]) === writeSyscall && Number.isSafeInteger(Number(exit[2]))) {
      return { ...base, event, result: Number(exit[2]) };
    }
  } else {
    if (event === "alloc_enter" || event === "packet_enter" || event === "copy_enter") {
      const bytes = integer(/\bbytes=(\d+)$/u.exec(body)?.[1]);
      if (bytes !== undefined) {
        return { ...base, event, bytes };
      }
    } else if (event === "copy_return") {
      const copiedBytes = integer(/\bresult=(\d+)$/u.exec(body)?.[1]);
      if (copiedBytes !== undefined) {
        return { ...base, event, copiedBytes };
      }
    } else if (event === "alloc_return" || event === "packet_return") {
      const result = /\bresult=(0x[a-f0-9]+)$/u.exec(body)?.[1];
      if (result) {
        return { ...base, event, isNull: BigInt(result) === 0n };
      }
    }
  }
  return undefined;
}

/** Bracket operations in one writer thread using the kernel's monotonic clock. */
export function androidAdbKernelWrites(events: AndroidAdbKernelEvent[], tid: number, fd: number) {
  type Write = { fd: number; bytes: number; events: AndroidAdbKernelEvent[] };
  const writes: (Write & { result: number })[] = [];
  let current: Write | undefined;
  for (const event of events) {
    if (event.tid !== tid) {
      continue;
    }
    if (event.event === "sys_enter") {
      current = event.fd === fd ? { fd, bytes: event.bytes, events: [event] } : undefined;
    } else if (current) {
      current.events.push(event);
      if (event.event === "sys_exit") {
        writes.push({ ...current, result: event.result });
        current = undefined;
      }
    }
  }
  return writes;
}

/** Fixed section protocol from the task-owned Android shell helper. */
export function androidAdbKernelCapture(text: string, writeSyscall: 1 | 64) {
  const events: AndroidAdbKernelEvent[] = [];
  const profiles: { event: string; hits: number; missed: number }[] = [];
  const stats: { cpu: number; key: string; value: number }[] = [];
  const memory: {
    uptimeSeconds?: number;
    meminfo: Record<string, number>;
    vmstat: Record<string, number>;
    buddy: { node: number; zone: string; orders: number[] }[];
  }[] = [];
  const identity: Record<string, string | number> = {};
  let section = "";
  let cpu = 0;
  let sample: (typeof memory)[number] | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const marker = /^OPENCLAW_KERNEL_SECTION ([a-z-]+)$/u.exec(line);
    if (marker) {
      section = marker[1]!;
      if (section === "uptime") {
        sample = { meminfo: {}, vmstat: {}, buddy: [] };
        memory.push(sample);
      }
      continue;
    }
    if (section === "identity") {
      const release =
        /^release=(\d+\.\d+\.\d+-android\d+-\d+-g[a-f0-9]+-ab\d+(?:-(?:4k|16k))?)$/u.exec(line);
      const arch = /^arch=(x86_64|aarch64)$/u.exec(line);
      if (release) {
        identity.release = release[1]!;
      } else if (arch) {
        identity.arch = arch[1]!;
      }
    } else if (section === "trace") {
      const event = androidAdbKernelLineFacts(line, writeSyscall);
      if (event) {
        events.push(event);
      }
    } else if (section === "profile") {
      const profile =
        /^\s*(?:oc_adb_kernel_\d+\/)?(alloc_enter|alloc_return|packet_enter|packet_return|copy_enter|copy_return)\s+(\d+)\s+(\d+)\s*$/u.exec(
          line,
        );
      if (profile) {
        profiles.push({ event: profile[1]!, hits: Number(profile[2]), missed: Number(profile[3]) });
      }
    } else if (section === "stats") {
      const processor = /^OPENCLAW_KERNEL_CPU (\d+)$/u.exec(line);
      if (processor) {
        cpu = Number(processor[1]);
      }
      const stat = /^(overrun|commit overrun|dropped events|entries):\s+(\d+)$/u.exec(line);
      if (stat) {
        stats.push({ cpu, key: stat[1]!, value: Number(stat[2]) });
      }
    } else if (sample && section === "uptime") {
      const uptime = /^(\d+\.\d+) \d+\.\d+$/u.exec(line);
      if (uptime) {
        sample.uptimeSeconds = Number(uptime[1]);
      }
    } else if (sample && section === "meminfo") {
      const value =
        /^(MemTotal|MemAvailable|MemFree|SwapFree|Slab|SReclaimable|SUnreclaim|KernelStack|PageTables):\s+(\d+) kB$/u.exec(
          line,
        );
      if (value) {
        sample.meminfo[value[1]!] = Number(value[2]);
      }
    } else if (sample && section === "vmstat") {
      const value =
        /^(oom_kill|allocstall_\w+|pgscan_direct\w*|pgsteal_direct\w*|compact_(?:fail|success|stall)|pgalloc_\w+) (\d+)$/u.exec(
          line,
        );
      if (value) {
        sample.vmstat[value[1]!] = Number(value[2]);
      }
    } else if (sample && section === "buddyinfo") {
      const buddy = /^Node (\d+), zone\s+(DMA|DMA32|Normal|Movable|HighMem)\s+([\d ]+)\s*$/u.exec(
        line,
      );
      if (buddy) {
        sample.buddy.push({
          node: Number(buddy[1]),
          zone: buddy[2]!,
          orders: buddy[3]!.trim().split(/\s+/u).map(Number),
        });
      }
    }
  }
  return {
    identity,
    events,
    profiles,
    stats,
    memory,
    ready: text.split(/\r?\n/u).includes("OPENCLAW_KERNEL_READY"),
    cleaned: text.split(/\r?\n/u).includes("OPENCLAW_KERNEL_CLEANED"),
  };
}
