import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "tsdown";
import { afterAll, beforeAll, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import {
  createRuntimeProcessBuildEntries,
  runtimeProcessCoreEntrypoints,
} from "../../scripts/lib/runtime-process-core-build-entries.mts";
import { createSqliteSchemaAssetsPlugin } from "../../scripts/lib/sqlite-schema-assets.mts";
import { createStateSchemaInlinePlugin } from "../../scripts/lib/state-schema-inline-plugin.mts";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sqliteImportMemorySupportUrl } from "./doctor-session-sqlite.memory.test-support.js";

const execFileAsync = promisify(execFile);
let bundleDir: string;
let childPath: string;

beforeAll(async () => {
  fs.mkdirSync(path.join(process.cwd(), ".artifacts"), { recursive: true });
  bundleDir = fs.mkdtempSync(path.join(process.cwd(), ".artifacts/import-memory-"));
  // Runtime workers resolve stable packaged paths beneath dist, even from a bundled caller.
  const outDir = path.join(bundleDir, "dist");
  fs.mkdirSync(outDir);
  childPath = path.join(outDir, "child.js");
  const { bundles } = await build({
    config: false,
    dts: false,
    entry: {
      child: fileURLToPath(sqliteImportMemorySupportUrl),
      ...createRuntimeProcessBuildEntries(runtimeProcessCoreEntrypoints),
    },
    format: "esm",
    // Keep generated source overhead out of the transcript-data heap budget;
    // preserve function/class names used by runtime dispatch and diagnostics.
    minify: { codegen: true, compress: true, mangle: { keepNames: true } },
    // Preserve lazy imports so unrelated runtime modules do not consume the child heap.
    outputOptions: { codeSplitting: true },
    outDir,
    outExtensions: () => ({ js: ".js" }),
    deps: {
      alwaysBundle: (id) =>
        Object.entries(packageJson.dependencies).some(
          ([name, version]) =>
            version.startsWith("workspace:") && (id === name || id.startsWith(`${name}/`)),
        ),
      neverBundle: Object.entries(packageJson.dependencies)
        .filter(([, version]) => !version.startsWith("workspace:"))
        .map(([name]) => name),
    },
    plugins: [createStateSchemaInlinePlugin(), createSqliteSchemaAssetsPlugin()],
    platform: "node",
    target: "node22",
    logLevel: "error",
  });
  for (const bundle of bundles) {
    await bundle[Symbol.asyncDispose]();
  }
});
afterAll(() => {
  if (bundleDir) {
    fs.rmSync(bundleDir, { force: true, recursive: true });
  }
});

it.each(["batch", "public"])(
  "imports %s transcripts and completes branch projections under a 256 MiB heap",
  async (scenario) => {
    const diagnostic = {
      stage: "launch",
      elapsedMs: 0,
      exited: false,
      closed: false,
      proofPublished: false,
    };
    onTestFailed(() => console.info("import-memory child status", diagnostic));
    await withOpenClawTestState({ applyEnv: false, label: "import-memory" }, async (state) => {
      const childRun = execFileAsync(
        resolveTestNodeExecPath(),
        ["--max-old-space-size=256", childPath, state.stateDir, scenario],
        {
          cwd: process.cwd(),
          env: state.env,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 180_000,
        },
      );
      let stderrLine = "";
      childRun.child.stderr?.on("data", (chunk: Buffer) => {
        stderrLine += chunk.toString();
        const lines = stderrLine.split("\n");
        stderrLine = (lines.pop() ?? "").slice(-1024);
        for (const line of lines) {
          const match =
            /^import-memory-stage (seed-start|seed-end|public-health-start|public-health-end|import-start|import-end|verify-start|verify-end|rerun-start|rerun-end|cleanup-start|cleanup-end) (\d+(?:\.\d+)?)$/.exec(
              line,
            );
          if (match?.[1] && Number.isFinite(Number(match[2]))) {
            diagnostic.stage = match[1];
            diagnostic.elapsedMs = Number(match[2]);
          }
        }
      });
      let proofOutput = "";
      childRun.child.stdout?.on("data", (chunk: Buffer) => {
        proofOutput = (proofOutput + chunk.toString()).slice(0, 1024 * 1024);
        try {
          const proof: unknown = JSON.parse(proofOutput);
          diagnostic.proofPublished =
            typeof proof === "object" &&
            proof !== null &&
            "scenario" in proof &&
            proof.scenario === scenario;
        } catch {
          // The existing proof JSON may span stdout chunks.
        }
      });
      childRun.child.once("exit", () => {
        diagnostic.exited = true;
      });
      childRun.child.once("close", () => {
        diagnostic.closed = true;
      });
      const { stdout } = await childRun;
      expect(JSON.parse(stdout)).toMatchObject({ scenario });
      console.info(stdout.trim());
    });
  },
  180_000,
);
