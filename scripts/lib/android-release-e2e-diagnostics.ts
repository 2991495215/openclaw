import path from "node:path";

/** Public failure facts must never copy command arguments, app text or raw logs. */
export function androidReleaseCommandFacts(
  bin: string,
  args: string[],
  stdout: string,
  stderr: string,
) {
  const output = `${stdout}\n${stderr}`;
  const basename = path.basename(bin);
  const tool = ["adb", "avdmanager", "emulator", "aapt2", "apksigner", "node", "git"].includes(
    basename,
  )
    ? basename
    : "other";
  const command = args[0] === "-s" ? args.slice(2) : args;
  const operation =
    tool === "adb" &&
    ["shell", "exec-out", "pull", "install", "forward", "reverse", "emu", "logcat"].includes(
      command[0] ?? "",
    )
      ? command[0]
      : "other";
  return {
    tool,
    operation,
    permissionDenied: /permission denied/iu.test(output),
    missingFile: /no such file or directory/iu.test(output),
    deviceOffline: /device offline/iu.test(output),
    connectionReset: /connection reset/iu.test(output),
    failedToCopy: /failed to copy/iu.test(output),
    timeout: /timed out|timeout/iu.test(output),
    transportClosed:
      tool === "adb" && /\b(?:error:[^\r\n]*\bclosed|connection closed)\b/iu.test(output),
    deviceMissing:
      tool === "adb" &&
      /\bdevice\b[^\r\n]*\bnot found\b|no devices\/emulators found/iu.test(output),
    remoteStatFailure:
      tool === "adb" &&
      /failed to stat remote object|remote object[^\r\n]*does not exist/iu.test(output),
    protocolFault: tool === "adb" && /protocol fault/iu.test(output),
    noSpace: tool === "adb" && /no space left on device/iu.test(output),
    readFailure:
      tool === "adb" && /failed to read|read failed|couldn't read|cannot read/iu.test(output),
    writeFailure:
      tool === "adb" && /failed to write|write failed|couldn't write|cannot write/iu.test(output),
    unexpectedEof: tool === "adb" && /unexpected (?:eof|end of file)|premature eof/iu.test(output),
    brokenPipe: tool === "adb" && /broken pipe/iu.test(output),
    connectionAborted: tool === "adb" && /connection aborted|connection refused/iu.test(output),
    serverRestart:
      tool === "adb" &&
      /daemon not running|daemon started successfully|server version .*doesn't match/iu.test(
        output,
      ),
    localCreateFailure:
      tool === "adb" &&
      /cannot create|failed to create|cannot mkdir|not a directory/iu.test(output),
    syncFailure:
      tool === "adb" &&
      /failed to receive|failed to send|failed to copy|unexpected id|failed to read copy response/iu.test(
        output,
      ),
    buildingFileListOnly: tool === "adb" && stderr.trim() === "pull: building file list...",
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  };
}

/** Emulator console records survive loss of the guest's ADB transport. */
export function androidReleaseConsoleLineFacts(line: string) {
  const fatal = /Fatal signal (\d+)\b.*\bpid (\d+) \(adbd\)/u.exec(line);
  if (fatal) {
    return { event: "adbd-fatal-signal", signal: Number(fatal[1]), pid: Number(fatal[2]) };
  }
  const crash = /pid: (\d+), tid: \d+, name: .*>>> ([^\r\n]+) <<</u.exec(line);
  if (crash) {
    return {
      event: "native-crash",
      pid: Number(crash[1]),
      process: /(?:^|\/)adbd$/u.test(crash[2]!) ? "adbd" : "other",
    };
  }
  const exit = /Service 'adbd' \(pid (\d+)\) (received signal|exited with status) (\d+)/u.exec(
    line,
  );
  if (exit) {
    return {
      event: exit[2] === "received signal" ? "adbd-exit-signal" : "adbd-exit-status",
      pid: Number(exit[1]),
      code: Number(exit[3]),
    };
  }
  if (/\bstarting service 'adbd'/u.test(line)) {
    return { event: "adbd-start" };
  }
  const started =
    /\b(?:started service 'adbd' has pid|Service 'adbd' started with pid) (\d+)/u.exec(line);
  if (started) {
    return { event: "adbd-started", pid: Number(started[1]) };
  }
  const frame = /#(\d+) pc ([a-f0-9]+)\s+(\S+)/u.exec(line);
  if (frame) {
    const module = path.basename(frame[3]!);
    return {
      event: "native-frame",
      index: Number(frame[1]),
      pc: frame[2],
      module: ["adbd", "libc.so", "libc++.so", "libbase.so", "libadbd.so"].includes(module)
        ? module
        : "other",
    };
  }
  if (/\bKernel panic - not syncing:/u.test(line)) {
    return { event: "kernel-panic" };
  }
  if (/\b(?:Out of memory:|Killed process \d+ \(adbd\))/u.test(line)) {
    return { event: "guest-out-of-memory" };
  }
  if (/\b(?:FORTIFY:|fdsan:|Scudo ERROR:|Check failed:)/u.test(line)) {
    return { event: "native-abort-check" };
  }
  return undefined;
}

/** Only numeric facts from the qualification-owned shell probe cross into artifacts. */
export function androidReleaseDeviceFacts(output: string) {
  const number = (key: string) => {
    const match = new RegExp(`^${key}=(\\d+)$`, "mu").exec(output);
    return match ? Number(match[1]) : null;
  };
  const screenshotSizes = [...output.matchAll(/^screenshot_bytes=(\d+)$/gmu)].map((match) =>
    Number(match[1]),
  );
  return {
    bootCompleted: number("boot_completed"),
    adbdPid: number("adbd_pid"),
    appPid: number("app_pid"),
    screenshotDirectory: number("screenshot_directory"),
    screenshotCount: screenshotSizes.length,
    screenshotBytes: screenshotSizes.reduce((total, size) => total + size, 0),
  };
}

export function androidReleaseHostFacts(processes: string, meminfo: string, memoryEvents: string) {
  const adbProcesses = [...processes.matchAll(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:\S*\/)?adb\s*$/gmu)]
    .slice(0, 16)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssKiB: Number(match[3]),
    }));
  const number = (text: string, key: string, suffix: string) => {
    const match = new RegExp(`^${key}\\s+(\\d+)${suffix}$`, "mu").exec(text);
    return match ? Number(match[1]) : null;
  };
  return {
    adbProcesses,
    availableKiB: number(meminfo, "MemAvailable:", " kB"),
    swapFreeKiB: number(meminfo, "SwapFree:", " kB"),
    oom: number(memoryEvents, "oom", ""),
    oomKill: number(memoryEvents, "oom_kill", ""),
  };
}

export function androidReleaseErrorFacts(error: unknown) {
  const names = ["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "AbortError"];
  const code: unknown =
    error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
  return {
    class: error instanceof Error && names.includes(error.name) ? error.name : "unknown",
    code:
      typeof code === "string" &&
      ["ETIMEDOUT", "ABORT_ERR", "EPROCESSGROUP_CLEANUP_FAILED"].includes(code)
        ? code
        : undefined,
  };
}

export function androidReleaseNativeFacts(text: string) {
  const classes = [
    "AssertionError",
    "IllegalStateException",
    "NullPointerException",
    "StaleObjectException",
  ];
  return {
    processCrashed: /INSTRUMENTATION_RESULT: shortMsg=Process crashed(?:\.|\r?\n|$)/u.test(text),
    instrumentationFailed: /INSTRUMENTATION_FAILED/u.test(text),
    OKsingle: /OK \(1 test\)/u.test(text),
    phaseReady: {
      initial: /OPENCLAW_ANDROID_PHASE_READY initial(?:\r?\n|$)/u.test(text),
      relaunch: /OPENCLAW_ANDROID_PHASE_READY relaunch(?:\r?\n|$)/u.test(text),
      "phone-restart": /OPENCLAW_ANDROID_PHASE_READY phone-restart(?:\r?\n|$)/u.test(text),
      "long-reply": /OPENCLAW_ANDROID_PHASE_READY long-reply(?:\r?\n|$)/u.test(text),
      reader: /OPENCLAW_ANDROID_PHASE_READY reader(?:\r?\n|$)/u.test(text),
    },
    class:
      classes.find((name) => new RegExp(`\\.${name}(?=[:\\s]|$)`, "u").test(text)) ?? "unknown",
    frames: [
      ...text.matchAll(
        /(AndroidReleaseWearTest|AndroidReleasePhoneTest|ReleaseValidationUi)\.kt:(\d+)/gu,
      ),
    ]
      .slice(0, 8)
      .map((match) => ({ file: `${match[1]}.kt`, line: Number(match[2]) })),
  };
}
