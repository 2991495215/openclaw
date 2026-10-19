import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  assertRetirementCut,
  parseRecoveryCommand,
  readActivation,
  retirementCuts,
  startInstalledRecoveryRun,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs";
import { resolveDockerE2ePlan } from "../../scripts/lib/docker-e2e-plan.mts";
import { quoteCliArg } from "../../src/cli/quote-cli-arg.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readJson, runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();
const fault = pathToFileURL(
  path.resolve("scripts/e2e/lib/upgrade-survivor/installed-recovery-fault.mjs"),
).href;
const operation = "12345678-1234-4234-8234-123456789abc";
const command = [
  "/runtime/node",
  "/private operator's/control/recovery.mjs",
  "--anchor",
  "/private operator's/anchor",
  "--operation",
  operation,
  "status",
];
const printed = `Package publication recovery: ${command.map(quoteCliArg).join(" ")}`;

it("invalidates an earlier PASS before setup and isolates repeated attempts", () => {
  const artifacts = dirs.make("installed-recovery-runs-");
  const first = startInstalledRecoveryRun(artifacts);
  const earlier = path.join(first.directory, "independent-recovery.mjs");
  fs.writeFileSync(earlier, "earlier helper");
  writeJson(first.summary, { status: "passed", runDirectory: path.basename(first.directory) });

  const second = startInstalledRecoveryRun(artifacts);
  expect(second.directory).not.toBe(first.directory);
  expect(second.summary).toBe(first.summary);
  expect(readJson(second.summary)).toEqual({
    status: "running",
    runDirectory: path.basename(second.directory),
  });
  expect(fs.readFileSync(earlier, "utf8")).toBe("earlier helper");
  const helper = path.join(second.directory, "independent-recovery.mjs");
  fs.writeFileSync(helper, "current helper", { flag: "wx" });
  expect(() => fs.writeFileSync(helper, "duplicate setup", { flag: "wx" })).toThrow();
  expect(readJson(second.summary).status).toBe("running");
  expect(fs.readFileSync(helper, "utf8")).toBe("current helper");
});

it("reads the printed recovery argv without evaluating quoted shell text", () => {
  expect(parseRecoveryCommand(`ordinary output\n${printed}\nordinary error`)).toEqual({
    node: command[0],
    helper: command[1],
    anchor: command[3],
    operation,
  });
  for (const invalid of [
    `${printed}; echo injected`,
    printed.replace("/runtime/node", "$(echo injected)"),
    printed.replace("/runtime/node", "NODE_OPTIONS=--import=other /runtime/node"),
    `${printed}\n${printed}`,
    printed.replace(" status", " repair"),
  ]) {
    expect(() => parseRecoveryCommand(invalid)).toThrow();
  }
});

it("selects current packed recovery without expanding the published baseline matrix", () => {
  const { plan } = resolveDockerE2ePlan({
    allowFrozenTargetScenarioOmissions: true,
    includeOpenWebUI: false,
    liveMode: "all",
    orderLanes: (lanes) => lanes,
    planReleaseAll: false,
    profile: "all",
    releaseChunk: "core",
    selectedLaneNames: ["package-installed-recovery"],
    timingStore: undefined,
  });
  expect(plan.lanes).toHaveLength(1);
  expect(plan.lanes[0]).toMatchObject({
    name: "package-installed-recovery",
    imageKind: "bare",
    stateScenario: "empty",
    live: false,
  });
  expect(plan.lanes[0]!.command).toContain(
    "OPENCLAW_UPGRADE_SURVIVOR_SCENARIO=package-installed-recovery",
  );
  expect(plan.lanes[0]!.command).not.toContain("OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE");
});

function fixture(cut: string) {
  const directory = fs.realpathSync(dirs.make("installed-recovery-observer-"));
  const root = path.join(directory, "openclaw");
  const anchor = path.join(directory, "activation");
  const helper = path.join(`${anchor}.control`, "recovery.mjs");
  const journal = path.join(`${anchor}.control`, "operation.sqlite");
  const evidence = path.join(directory, "observed.json");
  const spec = path.join(directory, "fault.json");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "selected"), "selected package bytes");
  fs.mkdirSync(`${anchor}.control`);
  fs.writeFileSync(helper, "original helper bytes");
  if (!cut.startsWith("helper-")) {
    fs.mkdirSync(anchor);
  }
  if (cut === "partial-previous") {
    fs.mkdirSync(path.join(anchor, "previous"));
    fs.writeFileSync(path.join(anchor, "previous/first"), "first obsolete leaf");
    fs.writeFileSync(path.join(anchor, "previous/second"), "remaining obsolete leaf");
  }
  const intent =
    cut === "displaced"
      ? { kind: "displace" }
      : cut === "partial-previous"
        ? { kind: "remove", name: "previous", selected: "candidate" }
        : {
            kind: cut.startsWith("anchor-") ? "remove-anchor" : "unlink-helper",
            selected: "candidate",
          };
  const phase =
    cut === "displaced" ? "publishing" : cut.startsWith("helper-") ? "anchor-retired" : "retiring";
  const db = new DatabaseSync(journal);
  db.exec(
    "CREATE TABLE package_activation(slot INTEGER, phase TEXT, intent_json TEXT, descriptor_json TEXT)",
  );
  db.prepare("INSERT INTO package_activation VALUES(1,?,?,?)").run(
    phase,
    JSON.stringify(intent),
    JSON.stringify({ operationId: operation, authority: { installKey: root } }),
  );
  db.close();
  const before = readActivation(journal);
  writeJson(spec, { cut, root, anchor, helper, journal, evidence });
  const run = (body: string, preloads: string[] = []) =>
    runProcess(
      node,
      [
        ...preloads,
        "--import",
        fault,
        "--input-type=module",
        "-e",
        `import fs from 'node:fs/promises';\nconst root=${JSON.stringify(root)};\nconst anchor=${JSON.stringify(anchor)};\nconst helper=${JSON.stringify(helper)};\n${body}`,
      ],
      { ...process.env, NODE_OPTIONS: "", OPENCLAW_SURVIVOR_INSTALLED_RECOVERY_FAULT: spec },
      10_000,
    );
  return { root, anchor, helper, journal, evidence, directory, before, run };
}

it("preserves every native Node SQLite column across strict JSON snapshots", () => {
  const f = fixture("displaced");
  const observations = pathToFileURL(
    path.resolve("scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs"),
  ).href;
  // Vitest may run on Bun; the installed driver uses Node's null-prototype rows.
  const result = runProcess(
    node,
    [
      "--input-type=module",
      "-e",
      `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { readActivation } from ${JSON.stringify(observations)};
      const journal = ${JSON.stringify(f.journal)};
      const db = new DatabaseSync(journal, { readOnly: true });
      try {
        const raw = db.prepare('SELECT * FROM package_activation').get();
        assert.equal(Object.getPrototypeOf(raw), null);
        assert.deepEqual(readActivation(journal), JSON.parse(JSON.stringify(raw)));
      } finally {
        db.close();
      }
    `,
    ],
    { ...process.env, NODE_OPTIONS: "" },
    10_000,
  );
  expect(result.status, result.stderr).toBe(0);
});

// These tests qualify the observer's physical boundaries, not installed recovery.
// Windows self-termination has no SIGKILL receipt and read-only directory sync
// has different semantics; the Docker cell requires the real POSIX boundaries.
it.skipIf(process.platform === "win32").each(["displaced", ...retirementCuts])(
  "interrupts at the designated real effect boundary: %s",
  (cut) => {
    const f = fixture(cut);
    const effects: Record<string, string> = {
      displaced: "await fs.rename(root, anchor + '/previous');",
      "partial-previous": "await fs.unlink(anchor + '/previous/first');",
      "anchor-before": "await fs.rmdir(anchor);",
      "anchor-after": "await fs.rmdir(anchor);",
      "anchor-sync": `await fs.rmdir(anchor); const handle = await fs.open(${JSON.stringify(f.directory)}, 'r'); await handle.sync(); await handle.close();`,
      "helper-before": "await fs.unlink(helper);",
      "helper-after": "await fs.unlink(helper);",
      "helper-sync":
        "await fs.unlink(helper); const handle = await fs.open(anchor + '.control', 'r'); await handle.sync(); await handle.close();",
    };
    const result = f.run(effects[cut]!);
    expect(result.signal, result.stderr).toBe("SIGKILL");
    const observed = readJson(f.evidence);
    expect(observed.row).toEqual(f.before);
    expect(readActivation(f.journal)).toEqual(f.before);
    if (cut === "displaced") {
      expect(fs.existsSync(f.root)).toBe(false);
      expect(fs.readFileSync(path.join(f.anchor, "previous/selected"), "utf8")).toBe(
        "selected package bytes",
      );
    } else {
      assertRetirementCut(cut, observed, f.anchor, f.helper);
      expect(fs.readFileSync(path.join(f.root, "selected"), "utf8")).toBe("selected package bytes");
    }
    if (cut === "partial-previous") {
      expect(fs.readFileSync(path.join(f.anchor, "previous/second"), "utf8")).toBe(
        "remaining obsolete leaf",
      );
    }
  },
);

it("does not claim a directory-sync cut when the real FileHandle.sync rejects", () => {
  const f = fixture("anchor-sync");
  const bootstrap = path.join(f.directory, "reject-sync.mjs");
  fs.writeFileSync(
    bootstrap,
    `
    import fs from 'node:fs/promises';
    const open = fs.open;
    fs.open = async (...args) => {
      const handle = await open(...args);
      if (args[0] === ${JSON.stringify(f.directory)}) handle.sync = async () => { throw new Error('real sync rejected'); };
      return handle;
    };
  `,
  );
  const result = f.run(
    `
    await fs.rmdir(anchor);
    const handle = await fs.open(${JSON.stringify(f.directory)}, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  `,
    ["--import", pathToFileURL(bootstrap).href],
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("real sync rejected");
  expect(fs.existsSync(f.evidence)).toBe(false);
  expect(readActivation(f.journal)).toEqual(f.before);
});
