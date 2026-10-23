import process from "node:process";
import { formatUncaughtError } from "../infra/errors.js";
import { runFatalErrorHooks } from "../infra/fatal-error-hooks.js";
import {
  isBenignUncaughtExceptionError,
  isUncaughtExceptionHandled,
} from "../infra/unhandled-rejections.js";
import { defaultRuntime, restoreRuntimeTerminalState } from "../runtime.js";
import { formatCliFailureLines, formatCliJsonFailure } from "./failure-output.js";
import { isJsonOutputModeActive } from "./json-output-mode.js";
import { exitAfterSignalExitBarriers } from "./signal-exit-barrier.js";

export function installCliUncaughtExceptionHandler(readArgv: () => string[]): void {
  process.on("uncaughtException", (error) => {
    if (isUncaughtExceptionHandled(error)) {
      return;
    }
    if (isBenignUncaughtExceptionError(error)) {
      console.warn(
        "[openclaw] Non-fatal uncaught exception (continuing):",
        formatUncaughtError(error),
      );
      return;
    }
    if (isJsonOutputModeActive(readArgv())) {
      defaultRuntime.writeJson(formatCliJsonFailure(error));
    }
    for (const line of formatCliFailureLines({
      title: "OpenClaw hit an unexpected runtime error.",
      error,
      argv: readArgv(),
    })) {
      console.error(line);
    }
    for (const message of runFatalErrorHooks({ reason: "uncaught_exception", error })) {
      console.error("[openclaw]", message);
    }
    restoreRuntimeTerminalState("uncaught exception");
    exitAfterSignalExitBarriers(1, "uncaught exception");
  });
}
