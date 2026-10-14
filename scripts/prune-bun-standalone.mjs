#!/usr/bin/env node
// Experimental post-build layout; leaves the normal package and full snapshot intact.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStandaloneSidecar } from "./lib/bun-standalone-sidecar.mjs";

const [buildDirectory, destination, traceFile] = process.argv.slice(2);
if (!buildDirectory || !destination || !traceFile) {
  throw new Error(
    "Usage: node scripts/prune-bun-standalone.mjs <build-directory> <new-runtime-directory> <trace.jsonl>",
  );
}
const buildRoot = path.resolve(buildDirectory);
const observations = fs
  .readFileSync(traceFile, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const paths = [...new Set(observations.map((entry) => entry.path))];
if (
  paths.some(
    (filename) =>
      typeof filename !== "string" ||
      path.isAbsolute(filename) ||
      filename.split(/[\\/]/).includes(".."),
  )
) {
  throw new Error("Trace paths must be relative to the runtime directory");
}
const files = paths.filter((filename) => {
  const candidate = path.join(buildRoot, "runtime", filename);
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
});
const nativeFiles = files.filter((filename) =>
  /\.(?:node|dylib|so(?:\.\d+)*|dll|wasm)$/.test(filename),
);
const report = createStandaloneSidecar({
  runtimeRoot: path.join(buildRoot, "runtime"),
  outputRoot: path.resolve(destination),
  embeddedPaths: JSON.parse(fs.readFileSync(path.join(buildRoot, "embedded-modules.json"), "utf8")),
  docsRoot: fileURLToPath(new URL("../docs/", import.meta.url)),
  nativeFiles,
  additionalFiles: files.filter((filename) => !/\.(?:[cm]?js|map)$/.test(filename)),
});
fs.writeFileSync(
  path.join(path.dirname(report.root), "sidecar-inventory.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({ files: report.files, symlinks: report.symlinks, bytes: report.bytes }),
);
