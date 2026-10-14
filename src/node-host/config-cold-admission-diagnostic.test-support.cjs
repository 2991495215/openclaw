// Diagnostic-only native gates; never merge this probe.
const fs = require("node:fs");
const path = require("node:path");
const { deserialize } = require("node:v8");
const { isMainThread, MessagePort, Worker } = require("node:worker_threads");

const role = process.env.OPENCLAW_NODE_CONFIG_DIAGNOSTIC_ROLE;
const stateDir = process.env.OPENCLAW_STATE_DIR;
if ((role === "a" || role === "b") && stateDir) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const receipt = (phase, fields = {}) => {
    fs.writeSync(4, `${JSON.stringify({ role, phase, pid: process.pid, ...fields })}\n`);
  };
  const pause = (phase, fields) => {
    receipt(phase, fields);
    if (fs.readSync(4, Buffer.alloc(1), 0, 1, null) !== 1) {
      throw new Error(`Diagnostic native gate closed: ${phase}`);
    }
  };

  if (isMainThread && role === "a") {
    const post = Worker.prototype.postMessage;
    let held = false;
    Worker.prototype.postMessage = function (request, ...rest) {
      if (!held && request?.type === "execute") {
        const command = deserialize(request.input);
        if (command.type === "nodeWorker.configure") {
          held = true;
          receipt("execute-held");
          const release = (message) => {
            if (message === "release-execute") {
              process.off("message", release);
              receipt("execute-released");
              Reflect.apply(post, this, [request, ...rest]);
            }
          };
          process.on("message", release);
          return;
        }
      }
      return Reflect.apply(post, this, [request, ...rest]);
    };
  }

  if (!isMainThread) {
    const post = MessagePort.prototype.postMessage;
    let schemaRequested = false;
    let schemaHeld = false;
    MessagePort.prototype.postMessage = function (message, ...rest) {
      if (
        role === "b" &&
        !schemaRequested &&
        message?.stage === "prepare" &&
        message.facts?.kind === "schema-maintenance" &&
        message.facts.databasePath === databasePath
      ) {
        schemaRequested = true;
        pause("before-schema-prepare", { exists: fs.existsSync(databasePath) });
      }
      if (message?.stage === "transaction" && message.facts?.kind === "node-worker-journal") {
        receipt("transaction-request");
      }
      if (role === "a" && observed && message?.ok === false) {
        receipt("refusal-reply");
      }
      return Reflect.apply(post, this, [message, ...rest]);
    };
    const stat = fs.statSync;
    fs.statSync = function (filename, ...rest) {
      const value = Reflect.apply(stat, this, [filename, ...rest]);
      if (role === "b" && schemaRequested && !schemaHeld && filename === databasePath) {
        schemaHeld = true;
        pause("schema-granted", { exists: value?.isFile() === true });
      }
      return value;
    };
    const read = fs.readFileSync;
    let observed = false;
    fs.readFileSync = function (...args) {
      const value = Reflect.apply(read, this, args);
      if (
        role === "a" &&
        !observed &&
        typeof value === "string" &&
        value.length < 8192 &&
        value.includes('"stateOwnerKind"')
      ) {
        let owner;
        try {
          owner = JSON.parse(value);
        } catch {}
        if (
          owner?.role === "sqlite-maintenance" &&
          owner.stateOwnerKind === "schema" &&
          owner.stateDir === stateDir &&
          owner.pid !== process.pid
        ) {
          observed = true;
          receipt("foreign-schema-read", {
            foreignPid: owner.pid,
            stack: new Error("Diagnostic observed real schema owner read").stack,
          });
        }
      }
      return value;
    };
  }
  require("node:module").syncBuiltinESMExports();
}
