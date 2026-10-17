import { clearActiveProgressLine } from "./progress-line.js";

const RESET_SEQUENCE =
  "\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[>4;0m";

type RestoreTerminalStateOptions = {
  /**
   * Stream to write the ANSI reset sequence to.
   * Callers that emit structured data to stdout should route the reset to
   * stderr so parseable output stays clean.
   *
   * Default: process.stdout.
   */
  resetStream?: NodeJS.WriteStream;
};

function reportRestoreFailure(scope: string, err: unknown, reason?: string): void {
  const suffix = reason ? ` (${reason})` : "";
  const message = `[terminal] restore ${scope} failed${suffix}: ${String(err)}`;
  try {
    process.stderr.write(`${message}\n`);
  } catch (writeErr) {
    console.error(`[terminal] restore reporting failed${suffix}: ${String(writeErr)}`);
  }
}

export function restoreTerminalState(
  reason?: string,
  options: RestoreTerminalStateOptions = {},
): void {
  const resetStream = options.resetStream ?? process.stdout;
  const restore = (scope: string, action: () => void) => {
    try {
      action();
    } catch (err) {
      reportRestoreFailure(scope, err, reason);
    }
  };
  restore("progress line", clearActiveProgressLine);

  const stdin = process.stdin;
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    restore("raw mode", () => stdin.setRawMode(false));
  }

  if (resetStream.isTTY) {
    restore("terminal reset", () => resetStream.write(RESET_SEQUENCE));
  }
}
