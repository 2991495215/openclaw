import { describe, expect, it } from "vitest";
import {
  androidReleaseAdbBridgeLineFacts,
  androidReleaseAdbGuestSocketFacts,
  androidReleaseAdbServerLineFacts,
  androidReleaseAdbSocketPair,
  androidReleaseAdbSyscallLineFacts,
  androidReleaseAdbdLineFacts,
  androidReleaseCommandFacts,
  androidReleaseConsoleLineFacts,
  androidReleaseDeviceFacts,
  androidReleaseErrorFacts,
  androidReleaseHostFacts,
  androidReleaseNativeFacts,
} from "../../scripts/lib/android-release-e2e-diagnostics.js";

describe("Android release public failure diagnostics", () => {
  it.each([
    ["guest-callback-close", "guest-callback-close"],
    ["guest-rst", "guest-rst"],
    ["guest-shutdown", "guest-shutdown"],
    ["guest-invalid-op", "guest-invalid-op"],
    ["guest-write-failure", "guest-write-failure"],
    ["private-target", undefined],
  ])("exports sanitized bridge stack offsets for %s", (target, expectedTarget) => {
    const facts = androidReleaseAdbBridgeLineFacts(
      "OPENCLAW_ADB_BRIDGE " +
        JSON.stringify({
          event: "hit",
          timeSeconds: 1792469182.031,
          gdbPid: 123,
          inferiorPid: 456,
          tid: 789,
          target,
          guestPort: 5555,
          hostPort: 50037,
          arguments: "private-token",
          frames: [
            { module: "emulator", offset: 12779856, function: "private-symbol" },
            { module: "/private/library.so", offset: 123, arguments: "private-token" },
            { module: "emulator", offset: "private-token" },
          ],
        }),
    );
    expect(facts).toMatchObject({
      event: "hit",
      timeSeconds: 1792469182.031,
      gdbPid: 123,
      inferiorPid: 456,
      tid: 789,
      target: expectedTarget,
      guestPort: 5555,
      hostPort: 50037,
      frames: [
        { module: "emulator", offset: 12779856 },
        { module: "other", offset: 123 },
        { module: "emulator", offset: null },
      ],
    });
    expect(JSON.stringify(facts)).not.toMatch(/private|arguments|function/u);
    expect(androidReleaseAdbBridgeLineFacts("GDB error: private-token")).toBeUndefined();
  });

  it.each([
    "not-json",
    "null",
    "[]",
    JSON.stringify({ event: "private-event", timeSeconds: 1, gdbPid: 123, inferiorPid: 456 }),
    JSON.stringify({ event: "installed", timeSeconds: 1, gdbPid: -1, inferiorPid: 456 }),
    JSON.stringify({ event: "installed", timeSeconds: 1, gdbPid: "123", inferiorPid: 456 }),
    JSON.stringify({ event: "hit", timeSeconds: "private-token", gdbPid: 123, inferiorPid: 456 }),
  ])("rejects invalid debugger protocol records: %s", (payload) => {
    expect(androidReleaseAdbBridgeLineFacts(`OPENCLAW_ADB_BRIDGE ${payload}`)).toBeUndefined();
  });

  const tcpHeader = "sl local_address rem_address st tx_queue tr retrnsmt uid timeout inode";
  const hostSocket = "0: 0100007F:C001 0100007F:15CD 01 0:0 00:0 0 1001 0 111";
  const peerSocket = "1: 0100007F:15CD 0100007F:C001 01 0:0 00:0 0 1001 0 222";

  it("accepts only numeric guest socket identity records", () => {
    expect(androidReleaseAdbGuestSocketFacts("OPENCLAW_ADB_VSOCK 14 12345 3 5555 2 5000")).toEqual({
      fd: 14,
      inode: 12345,
      localCid: 3,
      localPort: 5555,
      peerCid: 2,
      peerPort: 5000,
    });
    for (const line of [
      "OPENCLAW_ADB_VSOCK 14 12345 3 5555 2 5000 private-token",
      "OPENCLAW_ADB_VSOCK 14 12345 3 5555 2 5000\nprivate-token",
      "OPENCLAW_ADB_VSOCK -1 12345 3 5555 2 5000",
      "OPENCLAW_ADB_VSOCK 14 999999999999999999999 3 5555 2 5000",
      "private-token",
    ]) {
      expect(androidReleaseAdbGuestSocketFacts(line)).toBeUndefined();
    }
  });

  it("matches the full reversed tuple for the owned ADB socket", () => {
    const table = [
      tcpHeader,
      hostSocket,
      peerSocket,
      "2: 0100007F:C002 0100007F:15CD 01 0:0 00:0 0 1001 0 333",
      "3: 0100007F:15CD 0100007F:C002 01 0:0 00:0 0 1001 0 444",
    ].join("\n");
    expect(androidReleaseAdbSocketPair(table, ["111"], 5581)).toEqual({
      hostInode: "111",
      peerInode: "222",
      clientPort: 49153,
    });
    expect(androidReleaseAdbSocketPair(table, ["999"], 5581)).toBeUndefined();
  });

  it.each([
    ["missing peer", [hostSocket]],
    ["ambiguous peer", [hostSocket, peerSocket, peerSocket]],
    ["ambiguous host", [hostSocket, hostSocket, peerSocket]],
    ["non-loopback peer", [hostSocket.replace("0100007F:15CD", "0100000A:15CD"), peerSocket]],
    ["closed host", [hostSocket.replace(" 01 ", " 08 "), peerSocket]],
  ])("rejects %s socket pairs", (_name, rows) => {
    expect(
      androidReleaseAdbSocketPair([tcpHeader, ...rows].join("\n"), ["111"], 5581),
    ).toBeUndefined();
  });

  it.each([
    [
      "read(0xd, 0x7fffeed, 0x18) = 0 <0.002000>",
      { operation: "read", fd: 13, requestedBytes: 24, result: 0, eof: true },
    ],
    [
      "read(13, 0x7fffeed, 24) = 24 <0.000020>",
      { operation: "read", fd: 13, requestedBytes: 24, result: 24, eof: false },
    ],
    ["read(0xd, 0x7fffeed, 0x18) = 0x18 <0.000020>", { result: 24, eof: false }],
    ["read(0xd, 0x7fffeed, 0) = 0 <0.000020>", { requestedBytes: 0, result: 0, eof: false }],
    [
      "read(0xd, 0x7fffeed, 0x18) = -1 ECONNRESET (Connection reset by peer) <0.000020>",
      { result: -1, errno: "ECONNRESET", eof: false },
    ],
    [
      "read(0xd, 0x7fffeed, 0x18) = -1 EPRIVATE (private-token) <0.000020>",
      { result: -1, errno: undefined },
    ],
    [
      "write(0xd, 0x7fffeed, 0x18) = -1 EPIPE (Broken pipe) <0.000020>",
      { operation: "write", errno: "EPIPE", eof: false },
    ],
    [
      "write(0x11, 0x7fffeed, 0x10008) = -1 EMSGSIZE (Message too long) <0.001456>",
      { operation: "write", requestedBytes: 65544, result: -1, errno: "EMSGSIZE" },
    ],
    [
      "write(0x11, 0x7fffeed, 0x10008) = -1 ENOMEM (Out of memory) <0.001456>",
      { operation: "write", requestedBytes: 65544, result: -1, errno: "ENOMEM" },
    ],
    [
      "writev(0xd, 0x7fffeed, 0x2) = 0x100 <0.000020>",
      { operation: "writev", requestedBytes: undefined, result: 256, eof: false },
    ],
    [
      "readv(0xd, 0x7fffeed, 0x2) = 0 <0.000020>",
      { operation: "readv", requestedBytes: undefined, eof: true },
    ],
    [
      "recvmsg(0xd, 0x7fffeed, 0) = -1 ECONNRESET (Connection reset by peer) <0.000020>",
      { operation: "recvmsg", errno: "ECONNRESET" },
    ],
    [
      "sendmsg(0xd, 0x7fffeed, 0) = 0x20 <0.000020>",
      { operation: "sendmsg", result: 32, requestedBytes: undefined },
    ],
    ["shutdown(0xd, 0x2) = 0 <0.000020>", { operation: "shutdown", fd: 13, result: 0, eof: false }],
    ["close(0xd) = 0 <0.000020>", { operation: "close", fd: 13, result: 0, eof: false }],
    [
      "recvfrom(0xd, 0x7fffeed, 0x100, 0, 0, 0) = 0 <0.000020>",
      { operation: "recvfrom", requestedBytes: 256, result: 0, eof: true },
    ],
    ["recvfrom(0xd, 0x7fffeed, 0, 0, 0, 0) = 0 <0.000020>", { requestedBytes: 0, eof: false }],
    [
      "sendto(0xd, 0x7fffeed, 0x100, 0x4000, 0, 0) = -1 EAGAIN (Resource temporarily unavailable) <0.000020>",
      { operation: "sendto", requestedBytes: 256, result: -1, errno: "EAGAIN", eof: false },
    ],

    [
      "shutdown(0xd, 0x1) = 0 <0.000020>",
      { operation: "shutdown", shutdownHow: 1, result: 0, eof: false },
    ],
  ])("exports only numeric syscall metadata for %s", (line, expected) => {
    const facts = androidReleaseAdbSyscallLineFacts(`1792466410.334000 ${line}`);
    expect(facts).toMatchObject({ startedAtSeconds: 1792466410.334, ...expected });
    expect(facts?.durationSeconds).toBeGreaterThan(0);
    expect(JSON.stringify(facts)).not.toMatch(/private|7fffeed/u);
  });

  it.each([
    '1792466410.334000 read(13, "private-token", 24) = 24 <0.000020>',
    "1792466410.334000 read(0xd, 0x7fffeed, 0x18 <unfinished ...>",
    "1792466410.334000 <... read resumed>) = 0 <0.000020>",
    "1792466410.334000 read(0xd, 0x7fffeed, 0x18) = 0 <0.000020>\nprivate-token",
  ])("does not export decoded, incomplete or multiline traces: %s", (line) => {
    expect(androidReleaseAdbSyscallLineFacts(line)).toBeUndefined();
  });

  it.each([
    ["read failed: EOF", "read-eof", undefined],
    ["read failed", "read-error", undefined],
    ["read failed: Connection reset by peer", "read-error", "ECONNRESET"],
    ["poll failed: Bad file descriptor", "poll-error", "EBADF"],
    ["write failed", "write-error", undefined],
    ["connection closed", "connection-closed", undefined],
    ["requested stop", "requested-stop", undefined],
    ["read failed: private-token", "read-error", undefined],
    ["private-token", "unknown", undefined],
  ])("sanitizes host ADB termination reason %s", (message, reason, errno) => {
    const facts = androidReleaseAdbServerLineFacts(
      `10-20 02:26:01.123 2962 2973 I adb : transport.cpp:1165 emulator-5580: connection terminated: ${message}`,
    );
    expect(facts).toEqual({
      event: "connection-terminated",
      port: 5580,
      reason,
      errno,
      hostTime: "10-20 02:26:01.123",
    });
    expect(JSON.stringify(facts)).not.toContain("private-token");
  });

  it("omits unrelated host logs and does not copy devices, paths or extra log lines", () => {
    expect(androidReleaseAdbServerLineFacts("private-token /private/path")).toBeUndefined();
    expect(
      androidReleaseAdbServerLineFacts("private-device: connection terminated: read failed: EOF"),
    ).toBeUndefined();
    const facts = androidReleaseAdbServerLineFacts(
      "emulator-5582: connection terminated: read failed: EOF /private/token",
    );
    expect(facts).toMatchObject({ port: 5582, reason: "read-error", errno: undefined });
    expect(JSON.stringify(facts)).not.toMatch(/private|token/u);
    expect(
      androidReleaseAdbServerLineFacts(
        "emulator-5580: connection terminated: read failed: EOF\nprivate-token",
      ),
    ).toBeUndefined();
  });

  it("exports guest transport decisions without identifiers or raw log text", () => {
    expect(
      androidReleaseAdbdLineFacts(
        "10-20 04:33:31.344 542 600 I adbd : private-peer: connection terminated: read failed",
      ),
    ).toEqual({ event: "connection-terminated", reason: "read-error", errno: undefined });
    expect(
      androidReleaseAdbdLineFacts(
        "10-20 04:33:31.345 542 600 I adbd : kicking transport private-peer",
      ),
    ).toEqual({ event: "transport-kick" });
    expect(
      androidReleaseAdbdLineFacts("I other : connection terminated: read failed"),
    ).toBeUndefined();
    expect(
      androidReleaseAdbdLineFacts("I adbd : connection terminated: private-token\nprivate-token"),
    ).toBeUndefined();
    const facts = androidReleaseAdbdLineFacts(
      "I adbd : private-peer: connection terminated: private-token",
    );
    expect(facts).toMatchObject({ reason: "unknown" });
    expect(JSON.stringify(facts)).not.toContain("private");
  });

  it.each([
    [
      "failed to copy /private/setup-secret: Permission denied",
      { permissionDenied: true, failedToCopy: true },
    ],
    ["No such file or directory: /private/setup-secret", { missingFile: true }],
    ["device offline: private-device", { deviceOffline: true }],
    ["Connection reset by peer: private-device", { connectionReset: true }],
    ["private-device timed out", { timeout: true }],
    ["adb: error: closed", { transportClosed: true }],
    ["adb: error: failed to get feature set: closed", { transportClosed: true }],
    ["adb: device 'private-device' not found", { deviceMissing: true }],
    ["adb: no devices/emulators found", { deviceMissing: true }],
    ["failed to stat remote object '/private/setup-secret'", { remoteStatFailure: true }],
    ["remote object '/private/setup-secret' does not exist", { remoteStatFailure: true }],
    ["protocol fault: private-device returned an unexpected response", { protocolFault: true }],
    [
      "failed to copy /private/setup-secret: No space left on device",
      { failedToCopy: true, noSpace: true },
    ],
    ["adb: error: failed to read copy response: Success", { readFailure: true, syncFailure: true }],
    [
      "adb: error: failed to write /private/setup-secret: Broken pipe",
      { writeFailure: true, brokenPipe: true },
    ],
    ["adb: error: unexpected EOF on private-device", { unexpectedEof: true }],
    ["Software caused connection abort: connection aborted", { connectionAborted: true }],
    ["* daemon not running; starting now at private-port", { serverRestart: true }],
    ["adb server version (40) doesn't match this client (41); killing...", { serverRestart: true }],
    ["adb: error: cannot create /private/output: Not a directory", { localCreateFailure: true }],
  ])(
    "identifies SDK facts from either stream for %s without private output",
    (output, expected) => {
      for (const isStdout of [true, false]) {
        const stdout = isStdout ? output : "private-token";
        const stderr = isStdout ? "private-token" : output;
        const facts = androidReleaseCommandFacts(
          "/private/sdk/adb",
          ["-s", "private-device", "pull", "/private/setup-secret", "/private/output"],
          stdout,
          stderr,
        );
        expect(facts).toMatchObject({
          tool: "adb",
          operation: "pull",
          stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: Buffer.byteLength(stderr),
          ...expected,
        });
        expect(JSON.stringify(facts)).not.toMatch(/private|secret|token/u);
      }
    },
  );

  it("recognizes a directory-list progress message without inventing a transfer error", () => {
    expect(
      androidReleaseCommandFacts("adb", ["pull"], "", "pull: building file list...\n"),
    ).toMatchObject({ buildingFileListOnly: true, stderrBytes: 28, syncFailure: false });
    expect(
      androidReleaseCommandFacts("adb", ["pull"], "", "pull: building file list... private"),
    ).toMatchObject({ buildingFileListOnly: false });
  });

  it.each([
    [
      "libc: Fatal signal 11 (SIGSEGV), code 1, fault addr 0x0 in tid 563 (adbd), pid 540 (adbd)",
      { event: "adbd-fatal-signal", signal: 11, pid: 540 },
    ],
    [
      "DEBUG: pid: 540, tid: 563, name: adbd  >>> /apex/com.android.adbd/bin/adbd <<<",
      { event: "native-crash", pid: 540, process: "adbd" },
    ],
    [
      "DEBUG: pid: 541, tid: 563, name: private  >>> /private/secret <<<",
      { event: "native-crash", pid: 541, process: "other" },
    ],
    [
      "init: Service 'adbd' (pid 540) received signal 11",
      { event: "adbd-exit-signal", pid: 540, code: 11 },
    ],
    [
      "init: Service 'adbd' (pid 540) exited with status 1",
      { event: "adbd-exit-status", pid: 540, code: 1 },
    ],
    ["init: starting service 'adbd'...", { event: "adbd-start" }],
    ["init: ... started service 'adbd' has pid 734", { event: "adbd-started", pid: 734 }],
    [
      "DEBUG: #00 pc 0000000000012345 /apex/com.android.adbd/bin/adbd (private_symbol+42)",
      { event: "native-frame", index: 0, pc: "0000000000012345", module: "adbd" },
    ],
    [
      "DEBUG: #01 pc 0000000000098765 /private/secret.so (private_symbol+42)",
      { event: "native-frame", index: 1, pc: "0000000000098765", module: "other" },
    ],
    ["[123.45] Kernel panic - not syncing: private", { event: "kernel-panic" }],
    ["Out of memory: Killed process 540 (adbd) private", { event: "guest-out-of-memory" }],
    [
      "adbd: page allocation failure: order:5, mode:0x40cc0(GFP_KERNEL), private",
      { event: "guest-page-allocation-failure", order: 5, mode: "0x40cc0" },
    ],
    [
      "WARNING: private failed to allocate skb on vsock socket with sk_refcnt == 0",
      { event: "guest-vsock-owner-failure" },
    ],
    ["libc: FORTIFY: private", { event: "native-abort-check", reason: "fortify" }],
    ["DEBUG: Abort message: 'fdsan: private'", { event: "native-abort-check", reason: "fdsan" }],
    ["libc: Scudo ERROR: private", { event: "native-abort-check", reason: "scudo" }],
    ["adbd: Check failed: private", { event: "native-abort-check", reason: "assertion" }],
  ])("exports console event facts without guest text: %s", (line, expected) => {
    const facts = androidReleaseConsoleLineFacts(line);
    expect(facts).toEqual(expected);
    expect(JSON.stringify(facts)).not.toMatch(/private|secret|symbol|apex/u);
  });

  it("omits unrelated guest output from console diagnostics", () => {
    expect(
      androidReleaseConsoleLineFacts("private-token and private message text"),
    ).toBeUndefined();
    expect(
      androidReleaseConsoleLineFacts("init: starting service 'private-secret'..."),
    ).toBeUndefined();
  });

  it("retains a native binary build ID for symbolizing a crash without its symbol or path", () => {
    expect(
      androidReleaseConsoleLineFacts(
        "DEBUG: #00 pc 0000000000012345 /apex/com.android.adbd/bin/adbd (private_symbol+42) (BuildId: 1234abcd)",
      ),
    ).toEqual({
      event: "native-frame",
      index: 0,
      pc: "0000000000012345",
      module: "adbd",
      buildId: "1234abcd",
    });
  });

  it("exports only numeric device facts, excluding paths and probe errors", () => {
    const facts = androidReleaseDeviceFacts(
      [
        "boot_completed=1",
        "adbd_pid=104",
        "app_pid=4466",
        "screenshot_directory=1",
        "screenshot_bytes=123",
        "screenshot_bytes=456",
        "stat: /private/setup-secret: Permission denied",
        "private-token=789",
      ].join("\n"),
    );
    expect(facts).toEqual({
      bootCompleted: 1,
      adbdPid: 104,
      appPid: 4466,
      screenshotDirectory: 1,
      screenshotCount: 2,
      screenshotBytes: 579,
    });
    expect(
      androidReleaseDeviceFacts("boot_completed=private-token\nscreenshot_bytes=secret"),
    ).toEqual({
      bootCompleted: null,
      adbdPid: null,
      appPid: null,
      screenshotDirectory: null,
      screenshotCount: 0,
      screenshotBytes: 0,
    });
  });

  it("retains ADB process identity and resource counters without unrelated processes or paths", () => {
    const facts = androidReleaseHostFacts(
      "  104 1 512 /private/sdk/platform-tools/adb\n  200 99 128 adb\n  301 1 1024 /private/secret-app\n",
      "MemAvailable:   12345 kB\nSwapFree: 678 kB\nprivate-token: 789 kB\n",
      "oom 2\noom_kill 1\nprivate-secret 42\n",
    );
    expect(facts).toEqual({
      adbProcesses: [
        { pid: 104, parentPid: 1, rssKiB: 512 },
        { pid: 200, parentPid: 99, rssKiB: 128 },
      ],
      availableKiB: 12345,
      swapFreeKiB: 678,
      oom: 2,
      oomKill: 1,
    });
    expect(JSON.stringify(facts)).not.toMatch(/private|secret|token|sdk/u);
    expect(androidReleaseHostFacts("", "", "")).toEqual({
      adbProcesses: [],
      availableKiB: null,
      swapFreeKiB: null,
      oom: null,
      oomKill: null,
    });
  });

  it("drops unknown tool, operation, output and native phase names", () => {
    expect(
      androidReleaseCommandFacts(
        "/private/unknown-secret",
        ["secret"],
        "private-token",
        "private-secret",
      ),
    ).toMatchObject({ tool: "other", operation: "other" });
    const facts = androidReleaseNativeFacts(
      "private.UnknownException: private-token\n at private.Secret(secret.kt:5)\n" +
        "OPENCLAW_ANDROID_PHASE_READY private-secret\nOPENCLAW_ANDROID_PHASE_READY initial-private-token\n",
    );
    expect(facts).toMatchObject({
      class: "unknown",
      frames: [],
      processCrashed: false,
      instrumentationFailed: false,
      OKsingle: false,
      phaseReady: {
        initial: false,
        relaunch: false,
        "phone-restart": false,
        "long-reply": false,
        reader: false,
      },
    });
    expect(JSON.stringify(facts)).not.toMatch(/private|secret|token|UnknownException/u);
  });

  it("publishes known managed failures without messages, causes or arbitrary codes", () => {
    const error = Object.assign(new Error("private-token"), {
      code: "ETIMEDOUT",
      cause: new Error("private-secret"),
    });
    expect(androidReleaseErrorFacts(error)).toEqual({ class: "Error", code: "ETIMEDOUT" });
    error.name = "private-name";
    error.code = "private-code";
    expect(androidReleaseErrorFacts(error)).toEqual({ class: "unknown", code: undefined });
    expect(androidReleaseErrorFacts({ message: "private", code: "ETIMEDOUT" })).toEqual({
      class: "unknown",
      code: undefined,
    });
  });

  it.each([
    ["java.lang.AssertionError: private-token", "AssertionError"],
    ["androidx.test.uiautomator.StaleObjectException", "StaleObjectException"],
  ])("retains native source locations for %s without private text", (exception, expectedClass) => {
    const facts = androidReleaseNativeFacts(
      `${exception}\n at ai.openclaw.wear.AndroidReleaseWearTest.releasePhase(AndroidReleaseWearTest.kt:121)\n at private.Secret(secret.kt:5)\n at ai.openclaw.release.ReleaseValidationUi.read(ReleaseValidationUi.kt:88)`,
    );
    expect(facts).toEqual({
      class: expectedClass,
      frames: [
        { file: "AndroidReleaseWearTest.kt", line: 121 },
        { file: "ReleaseValidationUi.kt", line: 88 },
      ],
      processCrashed: false,
      instrumentationFailed: false,
      OKsingle: false,
      phaseReady: {
        initial: false,
        relaunch: false,
        "phone-restart": false,
        "long-reply": false,
        reader: false,
      },
    });
    expect(JSON.stringify(facts)).not.toMatch(/private|token|Secret/u);
  });

  it.each([
    [
      "INSTRUMENTATION_RESULT: shortMsg=Process crashed.\nprivate-token",
      { processCrashed: true, instrumentationFailed: false, OKsingle: false },
    ],
    [
      "INSTRUMENTATION_FAILED: private-token",
      { processCrashed: false, instrumentationFailed: true, OKsingle: false },
    ],
    [
      "OK (1 test)\nprivate-token",
      { processCrashed: false, instrumentationFailed: false, OKsingle: true },
    ],
  ])("retains native terminal facts for %s without raw results", (text, expected) => {
    const facts = androidReleaseNativeFacts(
      "OPENCLAW_ANDROID_PHASE_READY initial\n" +
        "OPENCLAW_ANDROID_PHASE_READY relaunch\n" +
        "OPENCLAW_ANDROID_PHASE_READY phone-restart\n" +
        "OPENCLAW_ANDROID_PHASE_READY long-reply\n" +
        "OPENCLAW_ANDROID_PHASE_READY reader\n" +
        text,
    );
    expect(facts).toEqual({
      class: "unknown",
      frames: [],
      ...expected,
      phaseReady: {
        initial: true,
        relaunch: true,
        "phone-restart": true,
        "long-reply": true,
        reader: true,
      },
    });
    expect(JSON.stringify(facts)).not.toMatch(
      /private|token|INSTRUMENTATION_|Process crashed|OK \(1 test\)/u,
    );
  });
});
