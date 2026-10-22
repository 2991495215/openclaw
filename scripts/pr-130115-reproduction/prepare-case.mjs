// Prepares synthetic configuration and launch descriptions; it does not start any service.
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.platform !== "darwin") {
  throw new Error("This case belongs to the disposable native GUI runner");
}
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const runnerRoot = await realpath(process.env.RUNNER_TEMP);
for (const item of [input.app, input.appHome, input.codexExecutable, input.seed, input.claudeSeed, path.dirname(input.caseRoot), input.output]) {
  if (!(await realpath(item)).startsWith(runnerRoot + path.sep)) throw new Error("Proof path escaped RUNNER_TEMP");
}
if (!['main', 'candidate'].includes(input.stage)) throw new Error("Unknown product stage");
const ports = [input.localPort, input.remotePort, input.controlPort];
if (new Set(ports).size !== 3 || ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) {
  throw new Error("The case needs three different valid loopback ports");
}
const seed = JSON.parse(await readFile(input.seed, "utf8"));
const claude = JSON.parse(await readFile(input.claudeSeed, "utf8"));
if (claude.status !== "synthetic_files_prepared" || claude.claudeCLIExecuted !== false) throw new Error("Expected explicit synthetic Claude parser inputs");
for (const fixture of claude.fixtures) {
  if (!(await realpath(fixture.file)).startsWith(runnerRoot + path.sep) ||
      createHash("sha256").update(await readFile(fixture.file)).digest("hex") !== fixture.sha256) {
    throw new Error("Claude parser input changed before the real catalog run");
  }
}
if (seed.seedVersion !== 2 || seed.status !== "visible_messages_read_by_fresh_codex_process" ||
    seed.modelResponseMode !== "synthetic_loopback" || seed.externalModelRequestsPermitted !== false ||
    seed.turnsStarted !== seed.fixtures?.length || seed.syntheticModelResponses !== seed.turnsStarted ||
    seed.networkCanaries?.deniedHits !== 0 || !seed.networkCanaries.deniedExit ||
    createHash("sha256").update(await readFile(input.codexExecutable)).digest("hex") !== seed.executableHash) {
  throw new Error("Synthetic data has not been verified through the real Codex store");
}
const fixtures = (owner) => {
  const result = seed.fixtures.filter((fixture) => fixture.owner === owner);
  if (result.length !== 3 || new Set(result.map((fixture) => fixture.root)).size !== 1) throw new Error("Incomplete real seed inventory");
  const external = claude.fixtures.filter((fixture) => fixture.owner === owner);
  if (external.length !== 3 || new Set(external.map((fixture) => fixture.root)).size !== 1) throw new Error("Incomplete Claude parser inventory");
  return [...result, ...external];
};
const mac = fixtures(input.macOwner);
const local = fixtures(input.localOwner);
const remote = fixtures(input.remoteOwner);
const appHome = await realpath(input.appHome);
const homeStat = await stat(appHome);
if (!homeStat.isDirectory() || homeStat.uid !== process.getuid() || (homeStat.mode & 0o077) !== 0) {
  throw new Error("The native app needs a private task-owned HOME (mktemp -d under RUNNER_TEMP)");
}
const nativeControlSocket = path.join(appHome, ".openclaw", "mac-control.sock");
if (Buffer.byteLength(nativeControlSocket) >= 104) {
  throw new Error("Native mac-control.sock would exceed Darwin sun_path; choose a shorter private HOME");
}
if (input.remoteOwner === input.macOwner) throw new Error("The remote Gateway control needs its own source store");
let implicitMacHome;
if (input.implicitMacHome) {
  implicitMacHome = await realpath(input.implicitMacHome);
  if (implicitMacHome !== appHome || input.localOwner !== input.macOwner ||
      await realpath(path.join(implicitMacHome, ".codex")) !== await realpath(mac[0].root) ||
      await realpath(path.join(implicitMacHome, ".claude")) !== await realpath(mac.find(row => row.catalogId === "claude").root)) {
    throw new Error("The HOME-fallback case needs its own seeded ~/.codex shared by the Mac and local Gateway");
  }
}
const localFixtures = input.macOwner === input.localOwner ? mac : [...mac, ...local];
const remoteFixtures = [...mac, ...remote];
const root = input.caseRoot;
await mkdir(root); // Never overwrite a previous case or operator state.
const runtime = path.join(input.app, "Contents/Resources/runtime");
const executable = await realpath(path.join(runtime, "bin/bun"));
const entry = await realpath(path.join(runtime, "lib/node_modules/openclaw/openclaw.mjs"));
const sqliteLibrary = await realpath(path.join(runtime, "lib/libsqlite3.dylib"));
const baseEnvironment = { PATH: `${path.dirname(executable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  OPENCLAW_SQLITE_LIBRARY: sqliteLibrary };
const localToken = "synthetic-pr130115-local-token";
const remoteToken = "synthetic-pr130115-remote-token";
const localURL = `ws://127.0.0.1:${input.localPort}`;
const remoteURL = `ws://127.0.0.1:${input.remotePort}`;
const gateways = [];
const writeJSON = (file, value) => writeFile(file, JSON.stringify(value, null, 2));

async function environment(label) {
  const home = path.join(root, label, "home");
  const state = path.join(root, label, "state");
  const temporary = path.join(root, label, "tmp");
  await mkdir(home, { recursive: true });
  await mkdir(state);
  await mkdir(temporary);
  return { ...baseEnvironment, HOME: home, CFFIXED_USER_HOME: home, TMPDIR: temporary,
    OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json") };
}

const pluginConfig = { allow: ["codex", "anthropic"], entries: { codex: { enabled: true, config: {
  appServer: { transport: "stdio", homeScope: "user", command: input.codexExecutable },
  sessionCatalog: { enabled: true },
} }, anthropic: { enabled: true, config: { sessionCatalog: { enabled: true } } } } };

async function gateway(label, port, token, rows) {
  const env = await environment(label);
  env.CODEX_HOME = rows[0].root;
  env.CLAUDE_CONFIG_DIR = rows.find(row => row.catalogId === "claude").root;
  if (label === "gateway-local" && implicitMacHome) {
    env.HOME = env.CFFIXED_USER_HOME = implicitMacHome;
    env.OPENCLAW_PROFILE = "catalogproof";
    delete env.CODEX_HOME;
    delete env.CLAUDE_CONFIG_DIR;
  }
  const workspace = path.join(root, label, "workspace");
  await mkdir(workspace);
  await writeJSON(env.OPENCLAW_CONFIG_PATH, { gateway: { mode: "local", port, auth: { mode: "token", token } },
    agents: { defaults: { workspace } }, plugins: pluginConfig });
  gateways.push({ label, executable, workingDirectory: workspace, arguments: [entry, "gateway", "run", "--bind", "loopback", "--port", String(port)],
    environment: env, logFile: path.join(input.output, `${label}.log`) });
}
await gateway("gateway-local", input.localPort, localToken, local);
await gateway("gateway-remote", input.remotePort, remoteToken, remote);

const appEnvironment = await environment("app");
appEnvironment.HOME = appEnvironment.CFFIXED_USER_HOME = appHome;
appEnvironment.OPENCLAW_PROFILE = "default";
appEnvironment.CODEX_HOME = mac[0].root;
appEnvironment.CLAUDE_CONFIG_DIR = mac.find(row => row.catalogId === "claude").root;
if (implicitMacHome) {
  appEnvironment.HOME = appEnvironment.CFFIXED_USER_HOME = implicitMacHome;
  delete appEnvironment.CODEX_HOME;
  delete appEnvironment.CLAUDE_CONFIG_DIR;
}
appEnvironment.NSUnbufferedIO = "YES";
const appWorkspace = path.join(root, "app", "workspace");
await mkdir(appWorkspace);
await writeJSON(appEnvironment.OPENCLAW_CONFIG_PATH, {
  gateway: { mode: "local", port: input.localPort, auth: { mode: "token", token: localToken } },
  agents: { defaults: { workspace: appWorkspace } }, plugins: pluginConfig,
});

async function observer(label, gatewayUrl, token, expected) {
  const env = await environment(label);
  await writeJSON(env.OPENCLAW_CONFIG_PATH, { gateway: { mode: "remote", remote: { transport: "direct", url: gatewayUrl, token } } });
  return { executable, entry, sqliteLibrary, home: env.HOME, state: env.OPENCLAW_STATE_DIR, config: env.OPENCLAW_CONFIG_PATH,
    gatewayUrl, fixtures: expected, rpcAdapter: input.rpcAdapter, rpcScopes: input.rpcScopes,
    rpcEnvironment: { ...env, NO_COLOR: "1", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_TEMP: process.env.RUNNER_TEMP } };
}
const control = { app: input.app, appEnvironment, appConfig: appEnvironment.OPENCLAW_CONFIG_PATH, output: input.output,
  controlPort: input.controlPort, gateways,
  local: await observer("observe-local", localURL, localToken, localFixtures),
  remote: await observer("observe-remote", remoteURL, remoteToken, remoteFixtures) };
await writeJSON(path.join(root, "control.json"), control);
await writeJSON(path.join(root, "ui-plan.json"), { stage: input.stage, app: input.app, appEnvironment,
  remoteURL, remoteToken, localFixtures, remoteFixtures });
await writeJSON(path.join(root, "launch.json"), { gateways, appEnvironment,
  controlSpec: path.join(root, "control.json"), uiPlan: path.join(root, "ui-plan.json"),
  controlURL: `http://127.0.0.1:${input.controlPort}`, keychainHome: appEnvironment.HOME,
  nativeControlSocket, nativeControlSocketUTF8Bytes: Buffer.byteLength(nativeControlSocket),
  caseKind: implicitMacHome ? "isolated-home-fallback" : input.macOwner === input.localOwner ? "shared-explicit-root" : "distinct-explicit-roots",
  status: "prepared_not_started" });
