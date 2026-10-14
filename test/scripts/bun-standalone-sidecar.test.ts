import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createStandaloneSidecar } from "../../scripts/lib/bun-standalone-sidecar.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

it("pruned sidecars retain assets and SDK shims share the embedded module instance", () => {
  const root = tempDirs.make("openclaw-sidecar-");
  const runtimeRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  const write = (relative: string, contents: string) => {
    const filename = path.join(runtimeRoot, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  };
  write("package.json", '{"name":"openclaw","type":"module"}');
  write("openclaw-install-owner.json", '{"schemaVersion":1,"owner":"macos-app"}');
  write(
    "dist/plugin-sdk/core.js",
    "export const registry = {}; export class Example {} export default registry;",
  );
  write("dist/worker.js", "export const value = 1;");
  write("dist/unused.js", "throw new Error('must not be copied');");
  write("dist/control-ui/assets/app.js", "browser asset");
  write("dist/cli-startup-metadata.json", "{}");
  write("dist/extensions/example/openclaw.plugin.json", '{"id":"example"}');
  write("extensions/example/package.json", '{"name":"@openclaw/example"}');
  write("extensions/example/unused.png", "duplicate source asset");
  write("skills/example/SKILL.md", "# Example");
  write("skills/example/scripts/run.py", "print('skill asset')");
  write("skills/example/assets/helper.wasm", "skill helper");
  write("node_modules/.pnpm/native/node_modules/native/package.json", '{"main":"index.js"}');
  write("node_modules/.pnpm/native/node_modules/native/addon.node", "native fixture");
  write("node_modules/.pnpm/native/node_modules/native/unused.dll", "foreign native fixture");
  write("node_modules/.pnpm/native/node_modules/native/schema.json", '{"type":"object"}');
  write("node_modules/.pnpm/native/node_modules/native/unused.json", "{}");
  write("node_modules/.pnpm/native/node_modules/native/index.js", "module.exports = {};");
  fs.symlinkSync(".pnpm/native/node_modules/native", path.join(runtimeRoot, "node_modules/native"));
  const docsRoot = path.join(root, "docs");
  fs.mkdirSync(docsRoot);
  fs.writeFileSync(path.join(docsRoot, "docs.json"), "{}");
  fs.writeFileSync(path.join(docsRoot, "guide.md"), "# Guide");
  fs.writeFileSync(path.join(docsRoot, "unneeded.png"), "image");
  const embedded = "/$bunfs/root/runtime/dist/plugin-sdk/core.js";
  const result = createStandaloneSidecar({
    runtimeRoot,
    outputRoot,
    docsRoot,
    additionalFiles: ["node_modules/native/schema.json"],
    nativeFiles: ["node_modules/native/addon.node"],
    embeddedPaths: {
      "dist/plugin-sdk/core.js": embedded,
      "dist/worker.js": "/$bunfs/root/runtime/dist/worker.js",
      "node_modules/.pnpm/native/node_modules/native/index.js": "/$bunfs/root/native.js",
      "../standalone-worker-threads.cjs": "/$bunfs/root/standalone-worker-threads.js",
    },
  });
  const read = (relative: string) => fs.readFileSync(path.join(outputRoot, relative), "utf8");
  assert.equal(
    read("dist/plugin-sdk/core.js"),
    `export * from "${embedded}";\nexport { default } from "${embedded}";\n`,
  );
  assert.equal(read("dist/worker.js"), 'export * from "/$bunfs/root/runtime/dist/worker.js";\n');
  assert.equal(
    read("node_modules/native/index.js"),
    'module.exports = require("/$bunfs/root/native.js");\n',
  );
  assert.equal(read("node_modules/native/addon.node"), "native fixture");
  assert.equal(read("node_modules/native/schema.json"), '{"type":"object"}');
  assert.equal(read("extensions/example/package.json"), '{"name":"@openclaw/example"}');
  assert.equal(read("docs/guide.md"), "# Guide");
  assert.equal(read("docs/docs.json"), "{}");
  assert.equal(read("openclaw-install-owner.json"), '{"schemaVersion":1,"owner":"macos-app"}');
  assert.equal(read("skills/example/scripts/run.py"), "print('skill asset')");
  assert.equal(read("skills/example/assets/helper.wasm"), "skill helper");
  assert.equal(read("dist/control-ui/assets/app.js"), "browser asset");
  assert.equal(fs.existsSync(path.join(outputRoot, "dist/unused.js")), false);
  assert.equal(fs.existsSync(path.join(outputRoot, "docs/unneeded.png")), false);
  assert.equal(fs.existsSync(path.join(outputRoot, "node_modules/native/unused.dll")), false);
  assert.equal(fs.existsSync(path.join(outputRoot, "node_modules/native/unused.json")), false);
  assert.equal(fs.existsSync(path.join(outputRoot, "extensions/example/unused.png")), false);
  assert.equal(result.symlinks, 1);
  const canonicalUrl = pathToFileURL(path.join(runtimeRoot, "dist/plugin-sdk/core.js")).href;
  const shimUrl = pathToFileURL(path.join(outputRoot, "dist/plugin-sdk/core.js")).href;
  const child = spawnSync(
    resolveTestNodeExecPath(),
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        return specifier === ${JSON.stringify(embedded)}
          ? { url: ${JSON.stringify(canonicalUrl)}, shortCircuit: true }
          : nextResolve(specifier, context);
      },
    });
    const canonical = await import(${JSON.stringify(canonicalUrl)});
    const shim = await import(${JSON.stringify(shimUrl)});
    assert.equal(shim.registry, canonical.registry);
    assert.equal(shim.default, canonical.registry);
    assert.ok(new shim.Example() instanceof canonical.Example);
    hooks.deregister();
  `,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  assert.throws(
    () => createStandaloneSidecar({ runtimeRoot, outputRoot, embeddedPaths: {} }),
    /already exists/,
  );
  assert.throws(
    () =>
      createStandaloneSidecar({
        runtimeRoot,
        outputRoot: path.join(root, "bad"),
        embeddedPaths: {},
        additionalFiles: ["../outside"],
      }),
    /escapes its root/,
  );
});
