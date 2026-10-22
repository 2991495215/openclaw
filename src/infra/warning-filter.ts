import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const warningFilterKey = Symbol.for("openclaw.warning-filter");

type ProcessWarningInstallState = {
  installed: boolean;
};

/** Installs the global process warning filter once for the current JS realm. */
export function installProcessWarningFilter(): void {
  const state = resolveGlobalSingleton<ProcessWarningInstallState>(warningFilterKey, () => ({
    installed: false,
  }));
  if (state.installed) {
    return;
  }

  const originalEmitWarning = process.emitWarning.bind(process);
  const wrappedEmitWarning: typeof process.emitWarning = ((...args: unknown[]) => {
    const warningArg = args[0];
    const secondArg = args[1];
    const thirdArg = args[2];
    let name: string | undefined;
    let code: string | undefined;
    let message: string | undefined;

    if (warningArg instanceof Error) {
      name = warningArg.name;
      message = warningArg.message;
      code = (warningArg as Error & { code?: string }).code;
    } else if (typeof warningArg === "string") {
      message = warningArg;
    }

    if (secondArg && typeof secondArg === "object" && !Array.isArray(secondArg)) {
      const options = secondArg as { type?: unknown; code?: unknown };
      if (typeof options.type === "string") {
        name = options.type;
      }
      if (typeof options.code === "string") {
        code = options.code;
      }
    } else {
      if (typeof secondArg === "string") {
        name = secondArg;
      }
      if (typeof thirdArg === "string") {
        code = thirdArg;
      }
    }

    if (
      (code === "DEP0040" && message?.includes("punycode")) ||
      (code === "DEP0060" && message?.includes("util._extend")) ||
      (name === "ExperimentalWarning" && message?.includes("SQLite is an experimental feature"))
    ) {
      return;
    }
    // Node does not emit Error + options warnings through the same path after wrapping; preserve
    // visibility by re-emitting a normalized warning object for unsuppressed cases.
    if (
      args[0] instanceof Error &&
      args[1] &&
      typeof args[1] === "object" &&
      !Array.isArray(args[1])
    ) {
      const warning = args[0];
      const emitted = Object.assign(new Error(warning.message), {
        name: warning.name,
        code: (warning as Error & { code?: string }).code,
      });
      process.emit("warning", emitted);
      return;
    }
    Reflect.apply(originalEmitWarning, process, args);
  }) as typeof process.emitWarning;

  process.emitWarning = wrappedEmitWarning;
  state.installed = true;
}
