import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { gitReadOnlyEnvironment } from "../../infra/git-exec.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { STAGED_INPUT_GIT_PATHSPEC } from "../../media/staged-inputs.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { withGitProcessOperation } from "../../process/spawn-diagnostics.js";
import { workerSshCommandOptions } from "./ssh.js";
import type { WorkspaceInventoryWriteCommand } from "./workspace-inventory-computation.js";
import { workspaceInventoryError } from "./workspace-inventory-error.js";

const STDERR_LIMIT = 4_096;
const COMMAND_KILL_GRACE_MS = 300;

/** Exact rsync exemptions, prepared once without walking input file contents. */
export async function readWorkspaceStagedInputDirectories(rootDir: string): Promise<string[]> {
  return await runGitWorkerOperation(
    { type: "workspace.inventory.staged-directories", input: { rootDir } },
    { inputBytes: Buffer.byteLength(rootDir) },
  );
}

export async function readWorkspaceTransferPaths(
  filePath: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  return await runGitWorkerOperation(
    { type: "workspace.inventory.paths", input: { filePath } },
    { signal, inputBytes: Buffer.byteLength(filePath) },
  );
}

async function writeInventory(
  command: WorkspaceInventoryWriteCommand,
  outputPath: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const output = await fs.open(outputPath, "wx", 0o600);
  try {
    await runGitWorkerOperation(command, {
      signal,
      inputBytes: Object.values(command.input).reduce(
        (bytes, value) => bytes + Buffer.byteLength(value),
        0,
      ),
      onInventoryChunk: async (bytes, context) => {
        context.signal.throwIfAborted();
        await output.writeFile(bytes, { signal: context.signal });
        context.signal.throwIfAborted();
      },
    });
    signal?.throwIfAborted();
    return outputPath;
  } finally {
    await output.close();
  }
}

export async function filterExistingGitTransferList(params: {
  gitRoot: string;
  preparedListPath: string;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<string> {
  return await writeInventory(
    {
      type: "workspace.inventory.existing",
      input: { gitRoot: params.gitRoot, preparedListPath: params.preparedListPath },
    },
    params.outputPath,
    params.signal,
  );
}

export async function runWorkspaceInventoryCommandToFile(params: {
  argv: string[];
  inputPath?: string;
  outputPath: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<void> {
  const [command, ...args] = params.argv;
  if (!command) {
    throw new Error("Worker workspace command requires an executable");
  }
  const output = await fs.open(params.outputPath, "wx", 0o600);
  let input: FileHandle | undefined;
  let stderr = "";
  const stderrDecoder = new StringDecoder("utf8");
  let outputBytes = 0;
  try {
    input = params.inputPath ? await fs.open(params.inputPath, "r") : undefined;
    params.signal.throwIfAborted();
    const env = params.baseEnv ?? workerSshCommandOptions({ timeoutMs: params.timeoutMs }).baseEnv;
    const result = await withGitProcessOperation(
      "workspace.inventory",
      () =>
        runUtf8CommandWithTimeout(params.argv, {
          baseEnv: command === "git" ? gitReadOnlyEnvironment(args, env) : env,
          ...(input ? { stdinFileDescriptor: input.fd } : { input: "" }),
          signal: params.signal,
          timeoutMs: params.timeoutMs,
          killProcessTree: true,
          killGraceMs: COMMAND_KILL_GRACE_MS,
          outputCapture: "discard",
          terminateOnOutputError: true,
          onOutputChunk: (chunk, stream) => {
            if (stream === "stderr") {
              stderr = sliceUtf16Safe(`${stderr}${stderrDecoder.write(chunk)}`, -STDERR_LIMIT);
              return;
            }
            outputBytes += chunk.byteLength;
            if (params.maxOutputBytes !== undefined && outputBytes > params.maxOutputBytes) {
              throw workspaceInventoryError(
                `Cloud workspace pack exceeds the ${params.maxOutputBytes} byte limit`,
              );
            }
            // Finish each raw chunk before accepting more output; the runner joins
            // the process tree before this adapter closes its file descriptor.
            let offset = 0;
            while (offset < chunk.byteLength) {
              const written = fsSync.writeSync(output.fd, chunk, offset, chunk.byteLength - offset);
              if (written === 0) {
                throw new Error("Worker workspace inventory write made no progress");
              }
              offset += written;
            }
          },
        }),
      "default",
    );
    stderr = sliceUtf16Safe(`${stderr}${stderrDecoder.end()}`, -STDERR_LIMIT);
    if (result.killIssuedByAbort) {
      params.signal.throwIfAborted();
    }
    const timedOut = result.termination === "timeout";
    if (result.termination !== "exit" || result.code !== 0) {
      const detail = timedOut ? `timed out after ${params.timeoutMs}ms` : stderr.trim();
      throw new Error(
        detail
          ? `Worker workspace file enumeration failed: ${detail}`
          : "Worker workspace file enumeration failed",
      );
    }
    params.signal.throwIfAborted();
  } finally {
    await output.close();
    await input?.close();
  }
}

export async function settleWorkspaceInventoryCommands(
  commands: Promise<void>[],
  signal: AbortSignal,
): Promise<void> {
  // Join every scratch-file writer before cleanup, preserving independent failures
  // ahead of cancellation so Move cannot mistake failed preflight for a clean Stop.
  for (const result of await Promise.allSettled(commands)) {
    if (result.status === "rejected" && (!signal.aborted || result.reason !== signal.reason)) {
      throw result.reason;
    }
  }
  signal.throwIfAborted();
}

export async function createWorkspaceGitTransferList(params: {
  gitRoot: string;
  temporaryDirectory: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<string> {
  const eligiblePath = path.join(params.temporaryDirectory, "eligible");
  const ignoredPath = path.join(params.temporaryDirectory, "ignored");
  const selectedPath = path.join(params.temporaryDirectory, "selected");
  const outputPath = path.join(params.temporaryDirectory, "transfer-list");
  const listFiles = (args: string[], destination: string) =>
    runWorkspaceInventoryCommandToFile({
      argv: ["git", "-C", params.gitRoot, "ls-files", "--full-name", ...args],
      outputPath: destination,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    });
  await fs.mkdir(params.temporaryDirectory, { mode: 0o700 });
  await listFiles(["--cached", "--others", "--exclude-standard", "-z"], eligiblePath);
  const worktreeIncludePath = path.join(params.gitRoot, ".worktreeinclude");
  const worktreeInclude = await fs.lstat(worktreeIncludePath).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
      return undefined;
    }
    throw error;
  });
  const hasWorktreeInclude = worktreeInclude?.isFile() === true;
  await settleWorkspaceInventoryCommands(
    [
      listFiles(
        [
          "--others",
          "--ignored",
          "--exclude-standard",
          "-z",
          ...(hasWorktreeInclude ? [] : ["--", STAGED_INPUT_GIT_PATHSPEC]),
        ],
        ignoredPath,
      ),
      hasWorktreeInclude
        ? listFiles(
            ["--others", "--ignored", `--exclude-from=${worktreeIncludePath}`, "-z"],
            selectedPath,
          )
        : fs.writeFile(selectedPath, "", { mode: 0o600 }),
    ],
    params.signal,
  );
  await writeInventory(
    {
      type: "workspace.inventory.select",
      input: { gitRoot: params.gitRoot, eligiblePath, ignoredPath, selectedPath },
    },
    outputPath,
    params.signal,
  );
  return outputPath;
}
