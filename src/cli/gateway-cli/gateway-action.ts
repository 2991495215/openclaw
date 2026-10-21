import type { Command } from "commander";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../failure-output.js";

export function gatewayAction(action: Parameters<Command["action"]>[0], label?: string) {
  return async function (this: Command, ...args: Parameters<typeof action>) {
    const json = Boolean(this.opts<{ json?: boolean }>().json);
    // JSON mode preserves structured gateway errors for automation callers.
    try {
      await action.apply(this, args);
    } catch (err) {
      // Completed output must reach CLI finalization without a second failure envelope.
      if (err instanceof ExitError) {
        throw err;
      }
      if (!json) {
        rethrowExpectedCliError(err);
      }
      if (json) {
        const { formatGatewayCallErrorJson } = await import("../../gateway/call-error-json.js");
        defaultRuntime.writeJson(formatGatewayCallErrorJson(err) ?? formatCliJsonFailure(err));
        defaultRuntime.exit(1);
        return;
      }
      const message = formatErrorMessage(err);
      defaultRuntime.error(label ? `${label}: ${message}` : message);
      defaultRuntime.exit(1);
    }
  };
}
