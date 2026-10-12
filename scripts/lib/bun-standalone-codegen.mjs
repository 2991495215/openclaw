import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const programOwners = [
  "src/media/staged-inputs.ts",
  "src/shared/sandbox-workspace-paths.ts",
  "src/gateway/worker-environments/workspace-path-exclusions.ts",
  "src/gateway/worker-environments/workspace-hash-memo.ts",
  "src/gateway/worker-environments/workspace-manifest-script.runtime.ts",
  "src/worker/workspace-seed-retention.ts",
];

function staticProgramCalls(contents, parse) {
  if (!contents.includes("compileFunction")) {
    return [];
  }
  const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
  const imports = new Set();
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration" || node.source.value !== "node:vm") {
      continue;
    }
    for (const specifier of node.specifiers) {
      if (specifier.imported?.name === "compileFunction") {
        imports.add(specifier.local.name);
      }
    }
  }
  const calls = [];
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (node.type === "CallExpression" && imports.has(node.callee?.name)) {
      const argument = node.arguments[0];
      // The return contract identifies a program across duplicated worker bundles.
      const signature =
        argument?.type === "TemplateLiteral" &&
        argument.expressions.every((expression) => expression.type === "Identifier")
          ? argument.quasis.reduce(
              (value, quasi, index) =>
                value + quasi.value.cooked + (argument.expressions[index]?.name ?? ""),
              "",
            )
          : undefined;
      calls.push({ node, signature });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        pending.push(...value);
      } else if (value && typeof value === "object") {
        pending.push(value);
      }
    }
  }
  return calls;
}

function protectBuiltinWrites(originalContents, parse) {
  let contents = originalContents;
  if (!/Error\.(?:stackTraceLimit|prepareStackTrace)/.test(contents)) {
    return { contents, count: 0 };
  }
  const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
  const pending = [[ast, undefined]];
  const edits = [];
  const isErrorProperty = (node) =>
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "Error" &&
    ["stackTraceLimit", "prepareStackTrace"].includes(node.property.name);
  while (pending.length) {
    const [node, parent] = pending.pop();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      parent?.type === "ExpressionStatement" &&
      isErrorProperty(node.left)
    ) {
      edits.push({
        start: node.start,
        end: node.end,
        replacement: `Reflect.set(Error, ${JSON.stringify(node.left.property.name)}, ${contents.slice(node.right.start, node.right.end)})`,
      });
    }
    if (
      node.type === "UnaryExpression" &&
      node.operator === "delete" &&
      isErrorProperty(node.argument)
    ) {
      edits.push({
        start: node.start,
        end: node.end,
        replacement: `Reflect.deleteProperty(Error, ${JSON.stringify(node.argument.property.name)})`,
      });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        pending.push(...value.map((child) => [child, node]));
      } else if (value && typeof value === "object") {
        pending.push([value, node]);
      }
    }
  }
  for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
    contents = contents.slice(0, edit.start) + edit.replacement + contents.slice(edit.end);
  }
  return { contents, count: edits.length };
}

/** Capture only fixed source programs, then emit their functions into the compiled graph. */
export async function createStandaloneCodegenAdapter({
  runtimeRoot,
  outputRoot,
  parse,
  stateRoot = path.join(
    path.dirname(outputRoot),
    "state",
    `${path.basename(outputRoot)}-static-codegen`,
  ),
}) {
  const distRoot = path.join(runtimeRoot, "dist");
  const candidates = fs.readdirSync(distRoot).filter((entry) => entry.endsWith(".mjs"));
  const entries = new Set();
  for (const owner of programOwners) {
    const basename = path.basename(owner, ".ts");
    const prefix =
      basename === "workspace-path-exclusions" ? "workspace-manifest-" : `${basename}-`;
    const matches = candidates.filter(
      (entry) =>
        entry.startsWith(prefix) &&
        fs.readFileSync(path.join(distRoot, entry), "utf8").includes(`//#region ${owner}\n`),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected one built static program owner for ${owner}, found ${matches.length}`,
      );
    }
    entries.add(path.join(distRoot, matches[0]));
  }
  const captureRoot = path.join(outputRoot, "static-codegen");
  fs.mkdirSync(captureRoot, { recursive: true });
  const resultPath = path.join(captureRoot, "programs.json");
  const entryPath = path.join(captureRoot, "capture-entry.mjs");
  fs.writeFileSync(
    entryPath,
    `import fs from "node:fs";
const records = new Map();
globalThis.__openclawCaptureStaticFunction = (signature, compile, ...args) => {
  const [code, params = [], options] = args;
  if (typeof code !== "string" || options !== undefined) throw new Error("Unsupported static program options");
  const record = { signature, code, params };
  const previous = records.get(signature);
  if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error("Ambiguous static program");
  records.set(signature, record);
  return compile(...args);
};
${[...entries].map((entry) => `await import(${JSON.stringify(entry)});`).join("\n")}
fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify([...records.values()], null, 2));
`,
  );
  const capture = await Bun.build({
    entrypoints: [entryPath],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "openclaw-static-codegen-capture",
        setup(build) {
          build.onLoad({ filter: /\.[cm]?js$/ }, async ({ path: filename }) => {
            if (
              !filename.startsWith(runtimeRoot + path.sep) ||
              filename.includes("/node_modules/")
            ) {
              return undefined;
            }
            let contents = await fs.promises.readFile(filename, "utf8");
            for (const { node, signature } of staticProgramCalls(contents, parse).toSorted(
              (left, right) => right.node.start - left.node.start,
            )) {
              if (!signature) {
                continue;
              }
              const callee = contents.slice(node.callee.start, node.callee.end);
              contents =
                contents.slice(0, node.callee.start) +
                `globalThis.__openclawCaptureStaticFunction.bind(null, ${JSON.stringify(signature)}, ${callee})` +
                contents.slice(node.callee.end);
            }
            return { contents, loader: "js", resolveDir: path.dirname(filename) };
          });
        },
      },
    ],
  });
  if (!capture.success) {
    throw new AggregateError(capture.logs, "Static program capture build failed");
  }
  const bundlePath = path.join(captureRoot, "capture-bundle.mjs");
  await Bun.write(bundlePath, capture.outputs[0]);
  fs.mkdirSync(path.join(stateRoot, "home"), { recursive: true });
  fs.mkdirSync(path.join(stateRoot, "tmp"), { recursive: true });
  const configPath = path.join(stateRoot, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n");
  const run = spawnSync(process.execPath, [bundlePath], {
    cwd: runtimeRoot,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(stateRoot, "home"),
      TMPDIR: path.join(stateRoot, "tmp"),
      OPENCLAW_STATE_DIR: stateRoot,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(captureRoot, "capture.log"), run.stdout + run.stderr);
  if (run.status !== 0) {
    throw new Error(`Static program capture failed: ${run.error ?? run.stderr}`);
  }
  const programs = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  if (programs.length !== programOwners.length) {
    throw new Error(
      `Expected ${programOwners.length} static programs, captured ${programs.length}`,
    );
  }
  const functions = new Map(
    programs.map(({ signature, code, params }) => {
      const expression = `(function(${params.join(", ")}) {\n${code}\n})`;
      // The same parser used by the main build checks the generated lexical function.
      parse(expression, { ecmaVersion: "latest", sourceType: "module" });
      return [signature, expression];
    }),
  );
  const residuals = [];
  return {
    programs,
    residuals,
    transform({ contents: originalContents, filename }) {
      let contents = originalContents;
      let typeboxAccelerationDisabled = false;
      const normalized = filename.replaceAll("\\", "/");
      if (
        normalized.includes("/typebox/") &&
        normalized.endsWith("/system/settings/settings.mjs")
      ) {
        contents += "\nSet({ useAcceleration: false });\n";
        typeboxAccelerationDisabled = true;
      }
      if (
        normalized.includes("/typebox/") &&
        normalized.endsWith("/system/environment/evaluate.mjs")
      ) {
        const signature = "export function CanEvaluate() {";
        if (!contents.includes(signature)) {
          throw new Error("Unsupported TypeBox CanEvaluate layout");
        }
        contents = contents.replace(
          signature,
          `${signature}\n    if (!Settings.Get().useAcceleration) return false;`,
        );
        typeboxAccelerationDisabled = true;
      }
      const guarded = protectBuiltinWrites(contents, parse);
      contents = guarded.contents;
      const calls = staticProgramCalls(contents, parse);
      let count = 0;
      for (const { node, signature } of calls.toSorted(
        (left, right) => right.node.start - left.node.start,
      )) {
        const expression = functions.get(signature);
        if (!expression) {
          residuals.push({ filename, expression: contents.slice(node.start, node.end) });
          continue;
        }
        contents = contents.slice(0, node.start) + expression + contents.slice(node.end);
        count += 1;
      }
      return {
        contents,
        count,
        typeboxAccelerationDisabled,
        guardedIntrinsicWrites: guarded.count,
      };
    },
  };
}
