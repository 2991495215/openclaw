import { describe, expect, it } from "vitest";
import {
  androidAdbKernelCapture,
  androidAdbKernelLineFacts,
  androidAdbKernelWrites,
} from "../../scripts/lib/android-adb-kernel-diagnostics.js";

// Native tracefs formatting: syscall args are hex; typed probe fields are decimal.
const trace = (body: string, tid = 603) => `private task-${tid} [001] ..... 224.197238: ${body}`;

describe("Android guest kernel diagnostic egress", () => {
  it.each([
    [
      "sys_enter: NR 1 (11, 7fffdeadbeef, 10008, 0, 0, 0)",
      { event: "sys_enter", fd: 17, bytes: 65544 },
    ],
    ["sys_exit: NR 1 = -12", { event: "sys_exit", result: -12 }],
    ["packet_enter: (0xffaa) bytes=65536", { event: "packet_enter", bytes: 65536 }],
    ["alloc_enter: (0xffaa) bytes=65580", { event: "alloc_enter", bytes: 65580 }],
    ["alloc_return: (0xffaa <- 0xffbb) result=0x0", { event: "alloc_return", isNull: true }],
    [
      "packet_return: (0xffaa <- 0xffbb) result=0xffff12345678",
      { event: "packet_return", isNull: false },
    ],
    ["copy_enter: (0xffaa) bytes=65536", { event: "copy_enter", bytes: 65536 }],
    ["copy_return: (0xffaa <- 0xffbb) result=32000", { event: "copy_return", copiedBytes: 32000 }],
  ])("exports only numeric facts and nullness from %s", (body, expected) => {
    const facts = androidAdbKernelLineFacts(trace(body), 1);
    expect(facts).toEqual({ tid: 603, timeSeconds: 224.197238, ...expected });
    expect(JSON.stringify(facts)).not.toMatch(/private|ffaa|ffbb|12345678|deadbeef/u);
  });

  it("rejects unrelated syscalls, raw text, unknown probes, and multiline records", () => {
    for (const line of [
      "private-token",
      trace("sys_exit: NR 64 = 24"),
      trace("secret_probe: (0xffaa) bytes=3"),
      trace("copy_return: (0xffaa) result=private-token"),
      trace("copy_return: (0xffaa) result=999999999999999999999999"),
      trace("copy_return: (0xffaa) result=24") + "\nprivate-token",
    ]) {
      expect(androidAdbKernelLineFacts(line, 1)).toBeUndefined();
    }
    expect(
      androidAdbKernelLineFacts(trace("sys_enter: NR 64 (10, 7fff, 18, 0, 0, 0)"), 64),
    ).toMatchObject({ fd: 16, bytes: 24 });
  });

  it("keeps failure events inside the original socket write, excluding other threads and descriptors", () => {
    const bodies = [
      trace("sys_enter: NR 1 (11, 7fff, 10008, 0, 0, 0)"),
      trace("packet_enter: (0xffaa) bytes=65536"),
      trace("alloc_return: (0xffaa <- 0xffbb) result=0x0", 602),
      trace("alloc_return: (0xffaa <- 0xffbb) result=0x0"),
      trace("packet_return: (0xffaa <- 0xffbb) result=0x0"),
      trace("sys_exit: NR 1 = -12"),
      trace("sys_enter: NR 1 (8, 7fff, 8, 0, 0, 0)"),
      trace("sys_exit: NR 1 = -12"),
    ];
    const events = bodies.map((line) => androidAdbKernelLineFacts(line, 1)!);
    const writes = androidAdbKernelWrites(events, 603, 17);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.events.map(({ event }) => event)).toEqual([
      "sys_enter",
      "packet_enter",
      "alloc_return",
      "packet_return",
      "sys_exit",
    ]);
    expect(writes[0]!.result).toBe(-12);
  });

  it("retains kernel identity, loss counters, and memory samples without private fields", () => {
    const captured = androidAdbKernelCapture(
      [
        "OPENCLAW_KERNEL_SECTION identity",
        "release=6.6.66-android15-8-gd0c43a640eab-ab13812146-4k",
        "arch=x86_64",
        "hostname=private-token",
        "OPENCLAW_KERNEL_SECTION profile",
        " alloc_return 1847 0",
        "oc_adb_kernel_603/copy_return 60 2",
        "private_probe 100 1",
        "OPENCLAW_KERNEL_SECTION stats",
        "OPENCLAW_KERNEL_CPU 1",
        "overrun: 0",
        "dropped events: 2",
        "private-field: 123",
        "OPENCLAW_KERNEL_SECTION uptime",
        "224.19 110.12",
        "OPENCLAW_KERNEL_SECTION meminfo",
        "MemAvailable:    123456 kB",
        "Slab:    32000 kB",
        "Private: 123 kB",
        "OPENCLAW_KERNEL_SECTION buddyinfo",
        "Node 0, zone   Normal  23 42 1 0 3",
        "Node 0, zone private-token 1 2 3",
        "OPENCLAW_KERNEL_SECTION vmstat",
        "oom_kill 0",
        "compact_fail 3",
        "private_token 42",
        "OPENCLAW_KERNEL_READY",
        "OPENCLAW_KERNEL_CLEANED",
      ].join("\n"),
      1,
    );
    expect(captured).toEqual({
      identity: { release: "6.6.66-android15-8-gd0c43a640eab-ab13812146-4k", arch: "x86_64" },
      events: [],
      profiles: [
        { event: "alloc_return", hits: 1847, missed: 0 },
        { event: "copy_return", hits: 60, missed: 2 },
      ],
      stats: [
        { cpu: 1, key: "overrun", value: 0 },
        { cpu: 1, key: "dropped events", value: 2 },
      ],
      memory: [
        {
          uptimeSeconds: 224.19,
          meminfo: { MemAvailable: 123456, Slab: 32000 },
          vmstat: { oom_kill: 0, compact_fail: 3 },
          buddy: [{ node: 0, zone: "Normal", orders: [23, 42, 1, 0, 3] }],
        },
      ],
      ready: true,
      cleaned: true,
    });
    expect(JSON.stringify(captured)).not.toMatch(/private|Private|hostname/u);
  });
});
