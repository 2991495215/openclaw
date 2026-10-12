#!/usr/bin/env bun
// Experimental macOS standalone recipe. Run after pnpm build; no installation changes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStandaloneCodegenAdapter } from "./lib/bun-standalone-codegen.mjs";
import { prepareStandaloneWorkers } from "./lib/bun-standalone-workers.mjs";

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
// Do not descend into plugin node_modules: Bun's recursive readdir follows their links.
function runtimeJavaScriptEntries(directory, relative = "") {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "control-ui", "worker-artifacts", "worker"].includes(entry.name)) {
      continue;
    }
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      result.push(...runtimeJavaScriptEntries(path.join(directory, entry.name), name));
    } else if (entry.isFile() && /\.(?:c?js)$/.test(entry.name)) {
      result.push(name);
    }
  }
  return result;
}
// Public built entries are independently addressable. Shared chunks stay shared and lazy.
const moduleEntries = runtimeJavaScriptEntries(path.join(runtimeRoot, "dist"))
  .map((entry) => `dist/${entry}`)
  .toSorted();
for (const entry of moduleEntries) {
  if (
    entry.startsWith("dist/extensions/") &&
    /(?:\.worker|\.child|-worker\.runtime)\.js$/.test(entry) &&
    !workerEntries.includes(entry)
  ) {
    workerEntries.push(entry);
  }
}
const telegramWorker = "dist/telegram-ingress-worker.runtime.js";
if (moduleEntries.includes(telegramWorker) && !workerEntries.includes(telegramWorker)) {
  workerEntries.push(telegramWorker);
}
moduleEntries.push(
  ...fs
    .readdirSync(runtimeRoot)
    .filter((entry) => entry.endsWith(".mjs"))
    .toSorted(),
);
// These libraries expose a few computed imports (notably secure-temp-root).
const runtimeRequire = createRequire(path.join(runtimeRoot, "package.json"));
for (const packageName of ["@openclaw/fs-safe", "@openclaw/proc-safe"]) {
  const manifest = runtimeRequire.resolve(`${packageName}/package.json`);
  const exports = JSON.parse(fs.readFileSync(manifest, "utf8")).exports;
  const pending = [exports];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string" && /\.[cm]?js$/.test(value)) {
      const entry = path
        .relative(runtimeRoot, path.resolve(path.dirname(manifest), value))
        .split(path.sep)
        .join("/");
      if (!moduleEntries.includes(entry)) {
        moduleEntries.push(entry);
      }
    } else if (value && typeof value === "object") {
      pending.push(...Object.values(value));
    }
  }
}
moduleEntries.push(
  path.relative(runtimeRoot, runtimeRequire.resolve("sqlite-vec")).split(path.sep).join("/"),
);
const moduleAliases = {};
for (const name of ["ws", "undici"]) {
  const directory = fs.realpathSync(path.join(runtimeRoot, "node_modules", name));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  const entry = path.resolve(directory, manifest.main);
  moduleAliases[name] = entry;
  moduleEntries.push(path.relative(runtimeRoot, entry).split(path.sep).join("/"));
}
const runtimeBootstrap = path.join(outputRoot, "standalone-runtime.mjs");
const embeddedPaths = Object.fromEntries(
  moduleEntries.map((entry) => [
    entry,
    `/$bunfs/root/runtime/${entry.replace(/\.[cm]js$/, ".js")}`,
  ]),
);
for (const [name, entry] of Object.entries(moduleAliases)) {
  embeddedPaths[name] = embeddedPaths[path.relative(runtimeRoot, entry).split(path.sep).join("/")];
}
const commonJsEntries = [
  ...moduleEntries.filter((entry) => entry.endsWith(".cjs")).map((entry) => embeddedPaths[entry]),
  ...Object.keys(moduleAliases).map((name) => embeddedPaths[name]),
];
fs.writeFileSync(
  runtimeBootstrap,
  `import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
const root = path.join(path.dirname(process.execPath), "runtime");
globalThis.__openclawStandaloneRootUrl = pathToFileURL(root + "/").href;
globalThis.__zod_globalConfig = { ...globalThis.__zod_globalConfig, jitless: true };
const entries = ${JSON.stringify(embeddedPaths)};
const commonJsEntries = new Set(${JSON.stringify(commonJsEntries)});
function embedded(pathname) {
  return entries[pathname] ?? entries[path.relative(root, pathname).split(path.sep).join("/")];
}
globalThis.__openclawStandaloneImport = (parent, specifier, options) => {
  const text = String(specifier);
  let target = text;
  if (text.startsWith("file:")) target = fileURLToPath(text);
  else if (!path.isAbsolute(text) && !text.startsWith("node:") && !text.startsWith("bun:")) {
    target = Bun.resolveSync(text, path.dirname(fileURLToPath(parent)));
  }
  target = embedded(target) ?? target;
  return (options ? import(target, options) : import(target)).then((loaded) =>
    commonJsEntries.has(target) ? { ...loaded.default, ...loaded } : loaded);
};
globalThis.__openclawStandaloneCreateRequire = (create, ...args) => {
  const require = create(...args);
  return new Proxy(require, { apply(target, receiver, [specifier, ...rest]) {
    const resolved = target.resolve(specifier);
    const entry = embedded(resolved);
    const loaded = Reflect.apply(target, receiver, [entry ?? specifier, ...rest]);
    return entry && commonJsEntries.has(entry) ? loaded.default ?? loaded : loaded;
  }});
};
let resolving = false;
if (isMainThread) Bun.plugin({ name: "openclaw-embedded-modules", setup(build) {
  build.onResolve({ filter: /.*/ }, ({path: specifier, importer, kind}) => {
    if (kind === "require-resolve" || resolving || specifier.startsWith("node:") || specifier.startsWith("bun:")) return;
    let target;
    try {
      resolving = true;
      target = specifier.startsWith("file:") ? fileURLToPath(specifier)
        : path.isAbsolute(specifier) ? specifier
        : (() => {
          try { return Bun.resolveSync(specifier, importer ? path.dirname(importer) : root); }
          catch { return Bun.resolveSync(specifier, root); }
        })();
    } catch { return; } finally { resolving = false; }
    const embedded = entries[path.relative(root, target).split(path.sep).join("/")];
    if (embedded) return {path: embedded, namespace: "file"};
  });
}});
if (process.env.OPENCLAW_STANDALONE_TRACE_PRELOAD) {
  await import(process.env.OPENCLAW_STANDALONE_TRACE_PRELOAD);
}
`,
);
const workers = prepareStandaloneWorkers({
  runtimeRoot,
  outputRoot,
  workerEntries,
  runtimeBootstrap,
  moduleAliases,
});
const workerMap = workerEntries
  .map(
    (entry) =>
      `${JSON.stringify(entry)}: () => import(${JSON.stringify(path.join(runtimeRoot, entry))})`,
  )
  .join(",\n");
const bootstrap = path.join(outputRoot, "standalone-entry.mjs");
fs.writeFileSync(
  bootstrap,
  `import ${JSON.stringify(runtimeBootstrap)};
import path from "node:path";
const root = path.join(path.dirname(process.execPath), "runtime");
const workers = {${workerMap}};
const moduleEntries = new Set(${JSON.stringify(moduleEntries)});
let args = process.argv.slice(2);
if (args[0] === "--no-install") args = args.slice(1);
if (args[0]?.startsWith(root + "/")) {
  const entry = args.shift();
  const relative = path.relative(root, entry);
  const load = workers[relative] ?? (moduleEntries.has(relative) ? () => import(entry) : undefined);
  if (!load) throw new Error("Unsupported standalone child: " + entry);
  process.argv = [process.execPath, entry, ...args];
  await load();
} else {
  process.argv[1] = path.join(root, "openclaw.mjs");
  await import(${JSON.stringify(path.join(runtimeRoot, "openclaw.mjs"))});
}
`,
);
const audit = process.env.OPENCLAW_STANDALONE_AUDIT_MODULE
  ? await import(pathToFileURL(process.env.OPENCLAW_STANDALONE_AUDIT_MODULE).href)
  : undefined;
const auditSites = [];
const codegen = await createStandaloneCodegenAdapter({ runtimeRoot, outputRoot, parse });
const codegenTransforms = [];
const transformedFiles = [];
const external = ["chromium-bidi/*", "@audio/decode-ape"];
const result = await Bun.build({
  entrypoints: [
    bootstrap,
    ...moduleEntries.map((entry) => path.join(runtimeRoot, entry)),
    ...workers.entrypoints,
  ],
  root: outputRoot,
  splitting: true,
  target: "bun",
  format: "esm",
  // These optional upstream imports are absent from this install, including normal Bun.
  external,
  outdir: path.join(outputRoot, "modules"),
  naming: {
    entry: "[dir]/[name].[ext]",
    chunk: "chunks/[name]-[hash].[ext]",
    asset: "assets/[name]-[hash].[ext]",
  },
  metafile: true,
  plugins: [
    {
      name: "openclaw-standalone-paths",
      setup(build) {
        build.onLoad({ filter: /\.[cm]?js$/ }, async ({ path: filename }) => {
          if (!filename.startsWith(runtimeRoot + "/")) {
            return undefined;
          }
          let contents = await fs.promises.readFile(filename, "utf8");
          const relative = path.relative(runtimeRoot, filename);
          const adapted = codegen.transform({ contents, filename });
          contents = adapted.contents;
          if (
            adapted.count ||
            adapted.typeboxAccelerationDisabled ||
            adapted.guardedIntrinsicWrites
          ) {
            codegenTransforms.push({
              file: relative,
              functions: adapted.count,
              guardedIntrinsicWrites: adapted.guardedIntrinsicWrites,
              typeboxAccelerationDisabled: adapted.typeboxAccelerationDisabled,
            });
          }
          if (/worker_threads|["'](?:ws|undici)["']/.test(contents)) {
            contents = workers.rewriteWorkerImports(
              filename,
              contents,
              parse(contents, { ecmaVersion: "latest", sourceType: "module" }),
            );
          }
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
          const ast = /import\.meta|import\s*\(|createRequire/.test(contents)
            ? parse(contents, {
                ecmaVersion: "latest",
                sourceType: "module",
                allowAwaitOutsideFunction: true,
              })
            : undefined;
          const requireFactories = new Set(
            (ast?.body ?? []).flatMap((node) =>
              node.type === "ImportDeclaration" && node.source.value === "node:module"
                ? node.specifiers
                    .filter((specifier) => specifier.imported?.name === "createRequire")
                    .map((specifier) => specifier.local.name)
                : [],
            ),
          );
          const pending = [ast];
          const edits = [];
          const physicalUrl = `(globalThis.__openclawStandaloneRootUrl + ${JSON.stringify(relative)})`;
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
              edits.push([node.start, node.end, physicalUrl]);
              continue;
            }
            if (
              node.type === "ImportExpression" &&
              (node.source.type !== "Literal" ||
                Object.values(moduleAliases).includes(node.source.value) ||
                String(node.source.value).endsWith(".cjs"))
            ) {
              edits.push([
                node.start,
                node.source.start,
                `globalThis.__openclawStandaloneImport(${physicalUrl}, `,
              ]);
            }
            if (
              node.type === "CallExpression" &&
              (requireFactories.has(node.callee?.name) ||
                (node.callee?.type === "MemberExpression" &&
                  node.callee.property?.name === "createRequire" &&
                  node.callee.object?.type === "CallExpression" &&
                  node.callee.object.callee?.property?.name === "getBuiltinModule"))
            ) {
              const name = contents.slice(node.callee.start, node.callee.end);
              edits.push([
                node.callee.start,
                node.callee.end,
                `globalThis.__openclawStandaloneCreateRequire.bind(null, ${name})`,
              ]);
            }
            for (const value of Object.values(node)) {
              if (Array.isArray(value)) {
                pending.push(...value);
              } else if (value && typeof value === "object") {
                pending.push(value);
              }
            }
          }
          for (const [start, end, replacement] of edits.toSorted((a, b) => b[0] - a[0])) {
            contents = contents.slice(0, start) + replacement + contents.slice(end);
          }
          if (audit) {
            const observed = audit.instrumentSource(contents, relative);
            contents = observed.contents;
            auditSites.push(...observed.sites);
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
fs.writeFileSync(
  path.join(outputRoot, "embedded-modules.json"),
  JSON.stringify(embeddedPaths, null, 2),
);
fs.writeFileSync(
  path.join(outputRoot, "codegen-transforms.json"),
  JSON.stringify(codegenTransforms, null, 2),
);
fs.writeFileSync(
  path.join(outputRoot, "codegen-residuals.json"),
  JSON.stringify(codegen.residuals, null, 2),
);
fs.writeFileSync(path.join(outputRoot, "audit-sites.json"), JSON.stringify(auditSites, null, 2));
const compiledEntries = result.outputs
  .filter((output) => output.path.endsWith(".js"))
  .map((output) => output.path);
// Bun preserves CJS -> ESM requires as import.meta.require in split output.
// The second split pass moves callers, so pin those edges to embedded entry names.
const splitRequireEdges = [];
const compiledEntrySet = new Set(compiledEntries);
for (const filename of compiledEntries) {
  let contents = fs.readFileSync(filename, "utf8");
  if (!contents.includes("import.meta.require")) {
    continue;
  }
  const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
  const pending = [ast];
  const edits = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "MemberExpression" &&
      node.callee.property?.name === "require" &&
      node.callee.object?.type === "MetaProperty"
    ) {
      const argument = node.arguments[0];
      if (
        argument?.type === "Literal" &&
        typeof argument.value === "string" &&
        argument.value.startsWith(".")
      ) {
        const target = path.resolve(path.dirname(filename), argument.value);
        if (compiledEntrySet.has(target)) {
          const relative = path
            .relative(path.join(outputRoot, "modules"), target)
            .split(path.sep)
            .join("/");
          edits.push([argument.start, argument.end, JSON.stringify(`/$bunfs/root/${relative}`)]);
          splitRequireEdges.push({ from: path.relative(outputRoot, filename), to: relative });
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        pending.push(...value);
      } else if (value && typeof value === "object") {
        pending.push(value);
      }
    }
  }
  for (const [start, end, replacement] of edits.toSorted((a, b) => b[0] - a[0])) {
    contents = contents.slice(0, start) + replacement + contents.slice(end);
  }
  if (edits.length) {
    fs.writeFileSync(filename, contents);
  }
}
fs.writeFileSync(
  path.join(outputRoot, "split-require-edges.json"),
  JSON.stringify(splitRequireEdges, null, 2),
);
const mainEntry = path.join(outputRoot, "modules/standalone-entry.js");
const executable = path.join(
  outputRoot,
  audit
    ? "openclaw-standalone-audit"
    : compileFlags.includes("--compile-aot")
      ? "openclaw-standalone-aot"
      : "openclaw-standalone",
);
const compiled = spawnSync(
  process.execPath,
  [
    "build",
    "--compile",
    "--splitting",
    `--root=${path.join(outputRoot, "modules")}`,
    "--compile-autoload-package-json",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...compileFlags,
    ...external.map((specifier) => `--external=${specifier}`),
    path.relative(path.join(outputRoot, "modules"), mainEntry),
    ...compiledEntries
      .filter((entry) => entry !== mainEntry)
      .map((entry) => path.relative(path.join(outputRoot, "modules"), entry)),
    `--outfile=${executable}`,
  ],
  { stdio: "inherit", cwd: path.join(outputRoot, "modules") },
);
if (compiled.status !== 0) {
  throw new Error(`Standalone compilation failed (${compiled.status})`);
}
console.log(`Standalone ready: ${executable}`);
