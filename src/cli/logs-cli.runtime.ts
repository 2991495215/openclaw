import { runCommandWithTimeout } from "../process/exec.js";

export { resolveGatewaySystemdServiceName } from "../daemon/constants.js";
export { readSystemdServiceRuntime } from "../daemon/systemd.js";

type ExecFileTailResult = { stdout: string; code: number; truncated: boolean };

const DEFAULT_LOG_SUBPROCESS_TIMEOUT_MS = 10_000;

export async function execFileUtf8Tail(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBytes: number; timeoutMs?: number },
): Promise<ExecFileTailResult> {
  try {
    const result = await runCommandWithTimeout([command, ...args], {
      baseEnv: options.env,
      maxOutputBytes: { stdout: options.maxBytes },
      outputCapture: { stderr: "discard" },
      timeoutMs: options.timeoutMs ?? DEFAULT_LOG_SUBPROCESS_TIMEOUT_MS,
    });
    return {
      stdout: result.stdout,
      code: result.code ?? 1,
      truncated: Boolean(result.stdoutTruncatedBytes),
    };
  } catch {
    return {
      stdout: "",
      code: 1,
      truncated: false,
    };
  }
}
