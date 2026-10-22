// One-shot SDK caller. Authority matches the native app; identity remains CLI.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("The SDK proof caller requires the disposable macOS runner");
}
const [entry, method, paramsJSON, expectUrl, timeoutText, scopesJSON] = process.argv.slice(2);
const root = realpathSync(process.env.RUNNER_TEMP);
function inside(value) {
  const resolved = realpathSync(value);
  if (!resolved.startsWith(root + path.sep)) throw new Error("SDK caller path escaped RUNNER_TEMP");
  return resolved;
}
inside(process.execPath);
inside(fileURLToPath(import.meta.url));
for (const name of ["HOME", "CFFIXED_USER_HOME", "TMPDIR", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_SQLITE_LIBRARY"]) {
  inside(process.env[name]);
}
if (inside(process.cwd()) !== inside(process.env.HOME) ||
    inside(process.env.CFFIXED_USER_HOME) !== inside(process.env.HOME)) throw new Error("Unexpected SDK caller home or cwd");
const packageRoot = path.dirname(inside(entry));
const packageFile = path.join(packageRoot, "package.json");
if (JSON.parse(readFileSync(packageFile, "utf8")).name !== "openclaw") throw new Error("Expected the installed OpenClaw package");
const sdkPath = inside(createRequire(packageFile).resolve("openclaw/plugin-sdk/gateway-runtime"));
if (!sdkPath.startsWith(packageRoot + path.sep)) throw new Error("SDK export resolved outside the installed package");
const scopes = JSON.parse(scopesJSON);
if (!Array.isArray(scopes) || scopes.length !== 6 || new Set(scopes).size !== 6 ||
    scopes.some(scope => typeof scope !== "string" || !scope.startsWith("operator."))) throw new Error("Invalid native scope contract");
const endpoint = new URL(expectUrl);
if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
  throw new Error("SDK caller requires the synthetic loopback Gateway");
}
const timeout = Number(timeoutText);
if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 80000) throw new Error("Invalid SDK caller deadline");
const { callGatewayFromCli } = await import(pathToFileURL(sdkPath).href);
if (typeof callGatewayFromCli !== "function") throw new Error("The installed public SDK caller is unavailable");
if (method === "--check-import") {
  process.stdout.write(JSON.stringify({ sdkPath, sdkSHA256: createHash("sha256").update(readFileSync(sdkPath)).digest("hex"),
    adapterSHA256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    executable: process.execPath, cwd: process.cwd(), scopes, clientName: "cli", mode: "cli" }) + "\n");
} else {
  if (!["health", "node.list", "node.describe", "node.pair.list", "node.pair.approve", "node.invoke",
    "sessions.catalog.list", "sessions.catalog.read"].includes(method)) throw new Error("RPC is outside this proof");
  try {
    const result = await callGatewayFromCli(method, { expectUrl, timeout: timeoutText, json: true }, JSON.parse(paramsJSON),
      { scopes, progress: false, sharedStateMode: "read-only" });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: { name: error.name, message: error.message,
      code: error.gatewayCode ?? error.code, details: error.details } }) + "\n");
    console.error(error);
    process.exitCode = 1;
  }
}
