import type { Command } from "commander";
import { requireStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";

type QaCliActionHandler = Parameters<Command["action"]>[0];

// The root CLI renderer hides unclassified error messages; QA failures are the operator's diagnostics.
export function qaCliAction(action: QaCliActionHandler): QaCliActionHandler {
  return async function (this: Command, ...args) {
    try {
      await action.apply(this, args);
    } catch (error) {
      // Lazy: keep the qa command registration path free of the error runtime.
      const { formatErrorMessage } = await import("openclaw/plugin-sdk/error-runtime");
      process.stderr.write(`${formatErrorMessage(error)}\n`);
      process.exitCode = 1;
    }
  };
}

/** For Commander argParser callbacks only; action-time errors are reported by qaCliAction. */
export function invalidQaCliArgument(message: string): Error & { code: string; exitCode: number } {
  return Object.assign(new Error(message), {
    name: "InvalidArgumentError",
    code: "commander.invalidArgument",
    exitCode: 1,
  });
}

export function parseQaCliPositiveIntegerOption(value: string, flag: string): number {
  return requireStrictPositiveInteger(value, () =>
    invalidQaCliArgument(`${flag} must be a positive integer.`),
  );
}

export function collectString(value: string, previous: string[]) {
  const trimmed = value.trim();
  return trimmed ? [...previous, trimmed] : previous;
}
