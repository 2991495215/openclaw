import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./direct-run.mjs";

export const standaloneExternalModules = ["chromium-bidi/*", "@audio/decode-ape"];

/** Compile the same prepared split graph in separate modes, one invocation at a time. */
export function compileStandalone({
  outputRoot,
  compiledEntries: providedEntries,
  compileFlags = [],
  audit = false,
}) {
  const modules = path.join(outputRoot, "modules");
  const compiledEntries =
    providedEntries ??
    fs
      .readdirSync(modules, { recursive: true })
      .filter((entry) => entry.endsWith(".js"))
      .toSorted()
      .map((entry) => path.join(modules, entry));
  const mainEntry = path.join(modules, "standalone-entry.js");
  const name = audit
    ? "audit"
    : compileFlags.includes("--compile-aot")
      ? "aot"
      : compileFlags.includes("--bytecode")
        ? "bytecode"
        : undefined;
  const executable = path.join(outputRoot, `openclaw-standalone${name ? `-${name}` : ""}`);
  const result = spawnSync(
    process.execPath,
    [
      "build",
      "--compile",
      "--splitting",
      `--root=${modules}`,
      "--compile-autoload-package-json",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      ...compileFlags,
      ...standaloneExternalModules.map((specifier) => `--external=${specifier}`),
      path.relative(modules, mainEntry),
      ...compiledEntries
        .filter((entry) => entry !== mainEntry)
        .map((entry) => path.relative(modules, entry)),
      `--outfile=${executable}`,
    ],
    { stdio: "inherit", cwd: modules },
  );
  if (result.status !== 0) {
    throw new Error(
      `Standalone compilation failed: ${result.error ?? result.signal ?? result.status}`,
    );
  }
  return executable;
}

if (isDirectRunUrl(import.meta.url)) {
  const [directory, ...compileFlags] = process.argv.slice(2);
  if (!directory || !globalThis.Bun) {
    throw new Error(
      "Usage: bun scripts/lib/bun-standalone-compile.mjs <prepared-build-directory> [--bytecode|--compile-aot]",
    );
  }
  console.log(
    `Standalone ready: ${compileStandalone({ outputRoot: path.resolve(directory), compileFlags })}`,
  );
}
