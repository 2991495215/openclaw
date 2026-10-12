#!/usr/bin/env bun
// Experimental macOS standalone recipe. Run after pnpm build; no installation changes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(sourceRoot, "package.json"));
const { parse } = require("acorn");
const [outputArgument, ...compileFlags] = process.argv.slice(2);
if (!outputArgument || !globalThis.Bun) {
  throw new Error(
    "Usage: bun scripts/build-bun-standalone.mjs <output-directory> [--bytecode|--compile-aot]",
  );
}
const outputRoot = path.resolve(outputArgument);
const runtimeRoot = path.join(outputRoot, "runtime");
fs.mkdirSync(outputRoot, { recursive: true });

// A snapshot keeps pnpm workspace links intact without depending on the checkout at runtime.
// Existing snapshots are deliberately reused. Choose a fresh output directory after pnpm build.
if (!fs.existsSync(runtimeRoot)) {
  fs.mkdirSync(runtimeRoot);
  const entries = ["dist", "node_modules", "packages", "extensions", "skills", "package.json"];
  entries.push(...fs.readdirSync(sourceRoot).filter((name) => name.endsWith(".mjs")));
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry);
    const destination = path.join(runtimeRoot, entry);
    if (process.platform === "darwin") {
      const copy = spawnSync("/bin/cp", ["-cR", source, destination], { stdio: "inherit" });
      if (copy.status !== 0) {
        throw new Error(`Could not clone ${source}`);
      }
    } else {
      fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    }
  }
  fs.mkdirSync(path.join(runtimeRoot, "docs/reference"), { recursive: true });
  fs.cpSync(
    path.join(sourceRoot, "docs/reference/templates"),
    path.join(runtimeRoot, "docs/reference/templates"),
    { recursive: true },
  );
  fs.mkdirSync(path.join(runtimeRoot, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRoot, "scripts/windows-cmd-helpers.mjs"),
    path.join(runtimeRoot, "scripts/windows-cmd-helpers.mjs"),
  );
}
if (!fs.existsSync(path.join(runtimeRoot, "dist/cli-startup-metadata.json"))) {
  throw new Error("The runtime snapshot needs a completed pnpm build, including CLI metadata.");
}

const registrySource = fs.readFileSync(
  path.join(sourceRoot, "src/infra/runtime-process-entrypoints.ts"),
  "utf8",
);
const workerEntries = [...registrySource.matchAll(/runtimeProcessEntrypoint\(\s*["']([^"']+)["']/g)]
  .map((match) => `dist/${match[1]}.js`)
  .filter((entry) => fs.existsSync(path.join(runtimeRoot, entry)));
const workerMap = workerEntries
  .map(
    (entry) =>
      `${JSON.stringify(entry)}: () => import(${JSON.stringify(path.join(runtimeRoot, entry))})`,
  )
  .join(",\n");
const bootstrap = path.join(outputRoot, "standalone-entry.mjs");
fs.writeFileSync(
  bootstrap,
  `import path from "node:path";
import { pathToFileURL } from "node:url";
const root = path.join(path.dirname(process.execPath), "runtime");
globalThis.__openclawStandaloneRootUrl = pathToFileURL(root + "/").href;
if (process.env.OPENCLAW_STANDALONE_TRACE_PRELOAD) {
  await import(process.env.OPENCLAW_STANDALONE_TRACE_PRELOAD);
}
const workers = {${workerMap}};
let args = process.argv.slice(2);
if (args[0] === "--no-install") args = args.slice(1);
if (args[0]?.startsWith(root + "/")) {
  const entry = args.shift();
  const load = workers[path.relative(root, entry)];
  if (!load) throw new Error("Unsupported standalone child: " + entry);
  process.argv = [process.execPath, entry, ...args];
  await load();
} else {
  process.argv[1] = path.join(root, "openclaw.mjs");
  await import(${JSON.stringify(path.join(runtimeRoot, "openclaw.mjs"))});
}
`,
);

const transformedFiles = [];
const bundle = path.join(outputRoot, "openclaw-bundle.js");
const result = await Bun.build({
  entrypoints: [bootstrap],
  target: "bun",
  format: "esm",
  outdir: outputRoot,
  naming: "openclaw-bundle.js",
  metafile: true,
  plugins: [
    {
      name: "openclaw-standalone-paths",
      setup(build) {
        build.onLoad({ filter: /\.[cm]?js$/ }, async ({ path: filename }) => {
          if (!filename.startsWith(runtimeRoot + "/") || filename.includes("/node_modules/")) {
            return undefined;
          }
          let contents = await fs.promises.readFile(filename, "utf8");
          const relative = path.relative(runtimeRoot, filename);
          // The launcher loops over legacy suffixes. Expose existing candidates to Bun's graph.
          if (relative === "openclaw.mjs") {
            const candidates = [
              ...new Set(
                [...contents.matchAll(/["'](\.\/dist\/[^"']+\.[cm]?js)["']/g)].map(
                  (match) => match[1],
                ),
              ),
            ].filter((entry) => fs.existsSync(path.join(runtimeRoot, entry)));
            const choices = candidates
              .map(
                (entry) =>
                  `specifier === ${JSON.stringify(entry)} ? import(${JSON.stringify(entry)}) : `,
              )
              .join("");
            contents = contents.replaceAll(
              "await import(specifier)",
              `await (${choices}import(new URL(specifier, globalThis.__openclawStandaloneRootUrl).href))`,
            );
          }
          // Rewrite syntax nodes only: loaders also contain quoted "import.meta.url" source.
          const ast = parse(contents, {
            ecmaVersion: "latest",
            sourceType: "module",
            allowAwaitOutsideFunction: true,
          });
          const pending = [ast];
          const edits = [];
          while (pending.length) {
            const node = pending.pop();
            if (!node || typeof node !== "object") {
              continue;
            }
            if (
              node.type === "MemberExpression" &&
              !node.computed &&
              node.property.name === "url" &&
              node.object?.type === "MetaProperty" &&
              node.object.meta.name === "import"
            ) {
              edits.push([node.start, node.end]);
              continue;
            }
            for (const value of Object.values(node)) {
              if (Array.isArray(value)) {
                pending.push(...value);
              } else if (value && typeof value === "object") {
                pending.push(value);
              }
            }
          }
          for (const [start, end] of edits.toSorted((a, b) => b[0] - a[0])) {
            contents =
              contents.slice(0, start) +
              `(globalThis.__openclawStandaloneRootUrl + ${JSON.stringify(relative)})` +
              contents.slice(end);
          }
          transformedFiles.push(relative);
          return { contents, loader: "js", resolveDir: path.dirname(filename) };
        });
      },
    },
  ],
});
if (!result.success) {
  throw new AggregateError(result.logs, "Standalone bundle failed");
}
fs.writeFileSync(path.join(outputRoot, "metafile.json"), JSON.stringify(result.metafile, null, 2));
fs.writeFileSync(
  path.join(outputRoot, "transformed.json"),
  JSON.stringify(
    transformedFiles.toSorted((a, b) => a.localeCompare(b)),
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(outputRoot, "worker-entries.json"),
  JSON.stringify(workerEntries, null, 2),
);
const compiled = spawnSync(
  process.execPath,
  [
    "build",
    "--compile",
    "--compile-autoload-package-json",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...compileFlags,
    bundle,
    `--outfile=${path.join(outputRoot, "openclaw-standalone")}`,
  ],
  { stdio: "inherit" },
);
if (compiled.status !== 0) {
  throw new Error(`Standalone compilation failed (${compiled.status})`);
}
console.log(`Standalone ready: ${path.join(outputRoot, "openclaw-standalone")}`);
