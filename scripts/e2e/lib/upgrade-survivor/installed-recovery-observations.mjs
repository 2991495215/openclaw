import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readDatabase } from "./observations.mjs";

export const retirementCuts = [
  "partial-previous",
  "anchor-before",
  "anchor-after",
  "anchor-sync",
  "helper-before",
  "helper-after",
  "helper-sync",
];

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const fileDigest = (file) => sha256(fs.readFileSync(file));
export const fileIdentity = (file) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

export function startInstalledRecoveryRun(artifacts) {
  const summary = path.join(artifacts, "installed-recovery.json");
  // Invalidate an earlier PASS before install or helper preparation can fail.
  // Keep prior attempt files separate; only this current pointer is replaced.
  fs.writeFileSync(summary, `${JSON.stringify({ status: "running" })}\n`, { mode: 0o600 });
  const directory = fs.mkdtempSync(path.join(artifacts, "installed-recovery-"));
  fs.writeFileSync(
    summary,
    `${JSON.stringify({ status: "running", runDirectory: path.basename(directory) })}\n`,
    { mode: 0o600 },
  );
  return { directory, summary };
}

export function readActivation(journal) {
  return readDatabase(journal, (db) => {
    const rows = db.prepare("SELECT * FROM package_activation").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slot, 1);
    // Node SQLite rows have a null prototype; JSON evidence uses plain objects.
    // Preserve every column while giving strict snapshots one representation.
    return { ...rows[0] };
  });
}

// Publication changes inodes, but must preserve every byte, mode and link target.
// Never follow links into an unrelated package or the isolated state directory.
export function packageTreeDigest(root) {
  const hash = createHash("sha256");
  const visit = (relative) => {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
    assert(kind !== "file" || stat.isFile(), `Unsupported package entry: ${file}`);
    hash.update(
      JSON.stringify([
        relative,
        kind,
        stat.mode & 0o7777,
        kind === "file" ? fileDigest(file) : kind === "link" ? fs.readlinkSync(file) : null,
      ]),
    );
    if (kind === "directory") {
      for (const name of fs
        .readdirSync(file)
        .toSorted((left, right) => left.localeCompare(right))) {
        visit(path.join(relative, name));
      }
    }
  };
  visit("");
  return hash.digest("hex");
}

// Decode only quoteCliArg's emitted grammar. This is data, never a shell program:
// no expansion, command substitution, double quotes, or general shell escapes.
export function parseRecoveryCommand(output) {
  const lines = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("Package publication recovery: "));
  assert.equal(lines.length, 1, "expected one printed external recovery command");
  const command = lines[0].slice("Package publication recovery: ".length);
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    let token = "";
    let consumed = false;
    while (index < command.length && command[index] !== " ") {
      consumed = true;
      if (command[index] === "'") {
        const end = command.indexOf("'", index + 1);
        assert(end !== -1, "unterminated recovery argument");
        token += command.slice(index + 1, end);
        index = end + 1;
      } else if (command.slice(index, index + 2) === "\\'") {
        token += "'";
        index += 2;
      } else {
        assert(/[A-Za-z0-9_/:=.,@%+-]/u.test(command[index]), "unexpected recovery command syntax");
        token += command[index++];
      }
    }
    assert(consumed && token.length > 0, "empty recovery argument");
    tokens.push(token);
    if (index < command.length) {
      index++;
      assert(index < command.length && command[index] !== " ", "unexpected recovery spacing");
    }
  }
  assert.equal(tokens.length, 7);
  const [node, helper, anchorFlag, anchor, operationFlag, operation, action] = tokens;
  assert.equal(anchorFlag, "--anchor");
  assert.equal(operationFlag, "--operation");
  assert.equal(action, "status");
  assert.match(operation, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  // The printed command belongs to the Linux container, regardless of test host.
  for (const file of [node, helper, anchor]) {
    assert(path.posix.isAbsolute(file) && path.posix.resolve(file) === file);
  }
  return { node, helper, anchor, operation };
}

export function assertRetirementCut(cut, evidence, anchor, helper) {
  assert.equal(evidence.cut, cut);
  const intent = JSON.parse(evidence.row.intent_json);
  if (cut === "partial-previous") {
    assert.equal(evidence.row.phase, "retiring");
    assert.equal(intent.kind, "remove");
    assert.equal(intent.name, "previous");
    assert.equal(fs.existsSync(evidence.effect), false);
    assert(fs.existsSync(path.join(anchor, "previous")), "cut must leave a partial obsolete tree");
  } else if (cut.startsWith("anchor-")) {
    assert.equal(evidence.row.phase, "retiring");
    assert.equal(intent.kind, "remove-anchor");
    assert.equal(fs.existsSync(anchor), cut === "anchor-before");
  } else {
    assert.equal(evidence.row.phase, "anchor-retired");
    assert.equal(intent.kind, "unlink-helper");
    assert.equal(fs.existsSync(anchor), false);
    assert.equal(fs.existsSync(helper), cut === "helper-before");
  }
  assert.equal(intent.selected, "candidate");
  if (cut.endsWith("-sync")) {
    assert.equal(evidence.synced, true, "cut must follow real directory fsync");
  }
}
