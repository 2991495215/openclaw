import { describe, expect, it } from "vitest";
import {
  androidReleaseCommandFacts,
  androidReleaseConsoleLineFacts,
  androidReleaseDeviceFacts,
  androidReleaseErrorFacts,
  androidReleaseHostFacts,
  androidReleaseNativeFacts,
} from "../../scripts/lib/android-release-e2e-diagnostics.js";

describe("Android release public failure diagnostics", () => {
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
