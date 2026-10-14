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
  // Short aliases stay below exec's argv limit; Bun resolves their real paths,
  // preserving the embedded names used by the runtime resolver.
  const aliases = fs.mkdtempSync(path.join(outputRoot, "compile-inputs-"));
  let result;
  try {
    const inputs = [mainEntry, ...compiledEntries.filter((entry) => entry !== mainEntry)].map(
      (entry, index) => {
        const alias = `${index}.js`;
        fs.symlinkSync(entry, path.join(aliases, alias));
        return alias;
      },
    );
    result = spawnSync(
      process.execPath,
      [
        "build",
        "--compile",
        "--splitting",
        "--format=esm",
        `--root=${modules}`,
        "--compile-autoload-package-json",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        ...compileFlags,
        ...standaloneExternalModules.map((specifier) => `--external=${specifier}`),
        ...inputs,
        `--outfile=${executable}`,
      ],
      { stdio: "inherit", cwd: aliases },
    );
  } finally {
    fs.rmSync(aliases, { recursive: true, force: true });
  }
  if (result.status !== 0) {
    throw new Error(
      `Standalone compilation failed: ${result.error ?? result.signal ?? result.status}`,
    );
  }
  return executable;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
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
