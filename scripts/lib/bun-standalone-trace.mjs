// Optional sidecar observer. Records paths only, never file or message contents.
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, threadId } from "node:worker_threads";

const destination = process.env.OPENCLAW_STANDALONE_TRACE;
if (destination) {
  const root = path.join(path.dirname(process.execPath), "runtime");
  const append = fs.appendFileSync.bind(fs);
  const seen = new Set();
  function note(operation, input) {
    const value = input instanceof URL && input.protocol === "file:" ? fileURLToPath(input) : input;
    if (typeof value !== "string") {
      return;
    }
    const filename = path.resolve(value);
    if (!filename.startsWith(root + path.sep)) {
      return;
    }
    const relative = path.relative(root, filename);
    const key = `${operation}:${relative}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    append(
      destination,
      JSON.stringify({ pid: process.pid, threadId, isMainThread, operation, path: relative }) +
        "\n",
    );
  }
  for (const method of [
    "readFileSync",
    "openSync",
    "readdirSync",
    "statSync",
    "accessSync",
    "realpathSync",
  ]) {
    const original = fs[method];
    fs[method] = function (filename, ...args) {
      const result = original.call(this, filename, ...args);
      note(method, filename);
      return result;
    };
    Object.assign(fs[method], original);
  }
  for (const method of ["readFile", "open", "readdir", "stat", "access", "realpath"]) {
    const original = fs.promises[method];
    fs.promises[method] = async function (filename, ...args) {
      const result = await original.call(this, filename, ...args);
      note(`promises.${method}`, filename);
      return result;
    };
  }
  for (const method of ["readFile", "open"]) {
    const original = fs[method];
    fs[method] = function (filename, ...args) {
      const callback = args.pop();
      return original.call(this, filename, ...args, function (error, ...results) {
        if (!error) {
          note(method, filename);
        }
        callback.call(this, error, ...results);
      });
    };
  }
  const createReadStream = fs.createReadStream;
  fs.createReadStream = function (filename, ...args) {
    const stream = createReadStream.call(this, filename, ...args);
    stream.once("open", () => note("createReadStream", filename));
    return stream;
  };
  if (globalThis.Bun) {
    const file = Bun.file;
    Bun.file = function (filename, ...args) {
      const blob = file.call(this, filename, ...args);
      return new Proxy(blob, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") {
            return value;
          }
          return (...parameters) => {
            const result = value.apply(target, parameters);
            if (
              typeof property === "string" &&
              ["text", "json", "arrayBuffer", "bytes"].includes(property)
            ) {
              return result.then((data) => {
                note(`Bun.file.${property}`, filename);
                return data;
              });
            }
            if (property === "stream") {
              note("Bun.file.stream-intent", filename);
            }
            return result;
          };
        },
      });
    };
  }
  const require = createRequire(import.meta.url);
  process.on("exit", () => {
    for (const filename of Object.keys(require.cache)) {
      note("module-cache", filename);
    }
  });
  const dlopen = process.dlopen;
  process.dlopen = function (module, filename, ...args) {
    const result = dlopen.call(this, module, filename, ...args);
    note("dlopen", filename);
    return result;
  };
  syncBuiltinESMExports();
}

if (process.env.FATBIN_EXTRA_PRELOAD) {
  await import(process.env.FATBIN_EXTRA_PRELOAD);
}
