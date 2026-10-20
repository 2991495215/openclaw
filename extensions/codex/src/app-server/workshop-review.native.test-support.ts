import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import {
  closeOwnedStdioProcess,
  createOwnedStdioProcess,
} from "openclaw/plugin-sdk/process-runtime";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { clearSharedCodexAppServerClientAndWait } from "./shared-client.js";

async function waitForSocket(socketPath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    // Subscribe before the first stat so binding between the check and wait cannot be missed.
    const watcher = watch(path.dirname(socketPath), () => void check());
    const finish = (error?: unknown) => {
      watcher.close();
      signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(
          error instanceof Error ? error : new Error("Native startup failed", { cause: error }),
        );
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(signal.reason);
    async function check() {
      try {
        if ((await fs.stat(socketPath)).isSocket()) {
          finish();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          finish(error);
        }
      }
    }
    watcher.once("error", finish);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    } else {
      void check();
    }
  });
}

/** Real pinned Codex with a private home, no credentials, and a caller-owned Responses server. */
export async function createWorkshopReviewNativeFixture(options: {
  root: string;
  baseUrl: string;
  modelId: string;
  signal: AbortSignal;
}) {
  const native = await createCodexNativeTestState(options.root);
  // Keep this directly below the caller's short temp root: macOS limits Unix socket paths.
  const socketPath = path.join(options.root, "rpc.sock");
  const appServerUrl = `unix://${socketPath}`;
  const catalogPath = path.join(options.root, "models.json");
  await fs.writeFile(
    catalogPath,
    JSON.stringify({
      models: [
        {
          slug: options.modelId,
          display_name: "Synthetic Workshop model",
          supported_reasoning_levels: [],
          shell_type: "local",
          visibility: "list",
          supported_in_api: true,
          priority: 1,
          support_verbosity: false,
          truncation_policy: { mode: "bytes", limit: 10000 },
          experimental_supported_tools: [],
          context_window: 200_000,
          model_messages: {
            instructions_template: "You are a test assistant.",
            collaboration_modes: { default: "Synthetic model-owned Default policy." },
          },
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(native.codexHome, "config.toml"),
    [
      `model=${JSON.stringify(options.modelId)}`,
      'model_provider="workshop-fixture"',
      `model_catalog_json=${JSON.stringify(catalogPath)}`,
      'cli_auth_credentials_store="ephemeral"',
      'web_search="disabled"',
      'approval_policy="never"',
      'sandbox_mode="read-only"',
      "[model_providers.workshop-fixture]",
      'name="Synthetic Workshop provider"',
      `base_url=${JSON.stringify(options.baseUrl)}`,
      'wire_api="responses"',
      "requires_openai_auth=false",
      "supports_websockets=false",
      "request_max_retries=0",
      "stream_max_retries=0",
      "[analytics]",
      "enabled=false",
      "[feedback]",
      "enabled=false",
    ].join("\n"),
  );

  let stderr = "";
  const child = await createOwnedStdioProcess({
    argv: [native.command, "app-server", "--listen", appServerUrl],
    cwd: native.cwd,
    env: native.env,
    exactEnv: true,
    abortSignal: options.signal,
    stderrDestination: new Writable({
      write(chunk: Buffer, _encoding, done) {
        stderr = (stderr + chunk.toString("utf8")).slice(-8_192);
        done();
      },
    }),
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await clearSharedCodexAppServerClientAndWait();
      } finally {
        child.kill("SIGTERM");
        await closeOwnedStdioProcess(child);
      }
    })());
  const startup = new AbortController();
  try {
    await Promise.race([
      waitForSocket(socketPath, AbortSignal.any([options.signal, startup.signal])),
      child.wait().then(({ code, signal }) => {
        throw new Error(`Native Workshop startup exited (${code ?? signal}): ${stderr}`);
      }),
    ]);
  } catch (error) {
    await close();
    throw error;
  } finally {
    startup.abort();
  }

  return {
    // Socket connections cannot borrow an operator login. "user" preserves the fixture's
    // custom provider; WebSocket agent scope would force the built-in OpenAI provider.
    appServer: { transport: "unix" as const, homeScope: "user" as const, url: appServerUrl },
    codexHome: native.codexHome,
    close,
  };
}
