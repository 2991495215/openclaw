import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const { parse } = createRequire(import.meta.url)("acorn");

const codeFile = /\.(?:[cm]?[jt]sx?|map)$/i;
const nativeFile = /\.(?:node|dylib|so(?:\.\d+)*|dll|wasm)$/i;

function contained(root, relative) {
  const absolute = path.resolve(root, relative);
  if (absolute === root || !absolute.startsWith(root + path.sep)) {
    throw new Error(`Sidecar path escapes its root: ${relative}`);
  }
  return absolute;
}

function walk(root, visit, relative = "") {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(root, visit, name);
    } else {
      visit(name, entry);
    }
  }
}

function keepAsset(relative) {
  if (relative.startsWith("docs/internal/")) {
    return false;
  }
  if (
    relative === "package.json" ||
    relative === "openclaw-install-owner.json" ||
    relative.startsWith("skills/")
  ) {
    return true;
  }
  if (relative.startsWith("docs/")) {
    return relative.endsWith(".md") || relative.endsWith(".json");
  }
  if (relative.startsWith("dist/control-ui/")) {
    return true;
  }
  if (/^(?:node_modules|packages)\//.test(relative)) {
    return relative.endsWith("/package.json") || nativeFile.test(relative);
  }
  // Source manifests provide package-name aliases; built plugin assets live in dist.
  if (relative.startsWith("extensions/")) {
    return /\/(?:package|openclaw\.plugin)\.json$/.test(relative);
  }
  if (relative.startsWith("dist/")) {
    return !codeFile.test(relative) && !relative.endsWith(".tsbuildinfo");
  }
  return false;
}

function moduleShim(source, embedded, commonJs) {
  if (commonJs) {
    return `module.exports = require(${JSON.stringify(embedded)});\n`;
  }
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const hasDefault = ast.body.some(
    (node) =>
      node.type === "ExportDefaultDeclaration" ||
      node.specifiers?.some((specifier) => specifier.exported?.name === "default"),
  );
  return (
    `export * from ${JSON.stringify(embedded)};\n` +
    (hasDefault ? `export { default } from ${JSON.stringify(embedded)};\n` : "")
  );
}

function isCommonJs(filename, runtimeRoot) {
  if (filename.endsWith(".cjs")) {
    return true;
  }
  if (filename.endsWith(".mjs")) {
    return false;
  }
  let directory = path.dirname(filename);
  while (directory.startsWith(runtimeRoot)) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      return JSON.parse(fs.readFileSync(manifest, "utf8")).type !== "module";
    }
    directory = path.dirname(directory);
  }
  return true;
}

/** Build a fresh experimental sidecar; never prune or change the source snapshot. */
export function createStandaloneSidecar({
  runtimeRoot: runtimeRootInput,
  outputRoot: outputRootInput,
  embeddedPaths,
  docsRoot: docsRootInput,
  additionalFiles = [],
  nativeFiles,
}) {
  const runtimeRoot = fs.realpathSync(runtimeRootInput);
  const outputRoot = path.resolve(outputRootInput);
  const docsRoot = docsRootInput ? fs.realpathSync(docsRootInput) : undefined;
  if (outputRoot === runtimeRoot || outputRoot.startsWith(runtimeRoot + path.sep)) {
    throw new Error("Sidecar output must be outside the runtime snapshot");
  }
  if (fs.existsSync(outputRoot)) {
    throw new Error(`Sidecar output already exists: ${outputRoot}`);
  }
  const selected = new Map();
  const links = [];
  const observedFile = (relative) => {
    const source = fs.realpathSync(contained(runtimeRoot, relative));
    const physicalRelative = path.relative(runtimeRoot, source).split(path.sep).join("/");
    contained(runtimeRoot, physicalRelative);
    if (!fs.statSync(source).isFile()) {
      throw new Error(`Expected sidecar file: ${relative}`);
    }
    return physicalRelative;
  };
  const nativeSelection =
    nativeFiles === undefined ? undefined : new Set(nativeFiles.map(observedFile));
  walk(runtimeRoot, (relative, entry) => {
    if (entry.isSymbolicLink()) {
      links.push(relative);
    } else if (
      entry.isFile() &&
      keepAsset(relative) &&
      (!/^(?:node_modules|packages)\//.test(relative) ||
        !nativeFile.test(relative) ||
        !nativeSelection ||
        nativeSelection.has(relative))
    ) {
      selected.set(relative, "asset");
    }
  });
  for (const relative of additionalFiles) {
    const sourceRelative = observedFile(relative);
    if (!sourceRelative.startsWith("docs/internal/")) {
      selected.set(sourceRelative, "observed");
    }
  }
  // Addressable modules remain real files for loader admission and require.resolve.
  // Their bodies only re-export the already embedded graph, including SDK singletons.
  for (const [relative, embedded] of Object.entries(embeddedPaths)) {
    if (!/\.[cm]?js$/.test(relative)) {
      continue;
    } // Package-name aliases are not file paths.
    if (relative.startsWith("../")) {
      continue;
    } // Builder-generated worker bootstrap outside runtime.
    const source = contained(runtimeRoot, relative);
    if (!fs.existsSync(source)) {
      continue;
    } // Generated bootstrap entries live outside runtime.
    if (typeof embedded !== "string" || !embedded.startsWith("/$bunfs/root/")) {
      throw new Error(`Expected embedded module path for ${relative}`);
    }
    selected.set(relative, "shim");
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  const inventory = [];
  for (const [relative, kind] of [...selected].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const source = contained(runtimeRoot, relative);
    const destination = contained(outputRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (kind === "shim") {
      fs.writeFileSync(
        destination,
        moduleShim(
          fs.readFileSync(source, "utf8"),
          embeddedPaths[relative],
          isCommonJs(source, runtimeRoot),
        ),
      );
    } else {
      fs.copyFileSync(source, destination);
    }
    inventory.push({ path: relative, kind, bytes: fs.statSync(destination).size });
  }
  if (docsRoot) {
    walk(docsRoot, (relative, entry) => {
      if (relative.split("/").includes("internal")) {
        return;
      }
      if (!entry.isFile() || (!relative.endsWith(".md") && relative !== "docs.json")) {
        return;
      }
      const destination = contained(outputRoot, `docs/${relative}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(contained(docsRoot, relative), destination);
      const index = inventory.findIndex((item) => item.path === `docs/${relative}`);
      if (index !== -1) {
        inventory.splice(index, 1);
      }
      inventory.push({
        path: `docs/${relative}`,
        kind: "docs",
        bytes: fs.statSync(destination).size,
      });
    });
  }
  // Retain only internal links with retained targets. No link may borrow the checkout.
  for (const relative of links) {
    const source = contained(runtimeRoot, relative);
    let resolved;
    try {
      resolved = fs.realpathSync(source);
    } catch {
      continue;
    }
    if (!resolved.startsWith(runtimeRoot + path.sep)) {
      continue;
    }
    const target = contained(outputRoot, path.relative(runtimeRoot, resolved));
    if (!fs.existsSync(target)) {
      continue;
    }
    const destination = contained(outputRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const targetRelative = path.relative(path.dirname(destination), target);
    fs.symlinkSync(targetRelative, destination);
    inventory.push({ path: relative, kind: "symlink", bytes: 0 });
  }
  inventory.sort((left, right) => left.path.localeCompare(right.path));
  return {
    root: outputRoot,
    files: inventory.filter((entry) => entry.kind !== "symlink").length,
    symlinks: inventory.filter((entry) => entry.kind === "symlink").length,
    bytes: inventory.reduce((sum, entry) => sum + entry.bytes, 0),
    inventory,
  };
}
