import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const canonicalMemoryTestSupportModuleUrl = import.meta.url;

async function main(): Promise<void> {
  const [stateDir, storeTemplate, mode] = process.argv.slice(2);
  if (!stateDir || !storeTemplate) {
    throw new Error("usage: <state-dir> <store-template>");
  }
  // HOLD/neverLand: preserve the last completed phase if the scale child is killed.
  const markPhase = (phase: string): void => {
    if (mode === "apply") {
      const cpu = process.cpuUsage();
      fs.writeSync(
        2,
        `[doctor-canonical-phase] ${phase} elapsedMs=${Math.round(performance.now())} cpuUserMs=${Math.round(cpu.user / 1_000)} cpuSystemMs=${Math.round(cpu.system / 1_000)}\n`,
      );
    }
  };
  const knownRepairPhases = new Set([
    "targets-resolved",
    "database-open-started",
    "database-open-finished",
    "inventory-started",
    "inventory-finished",
    "hydration-started",
    "hydration-finished",
    "selection-finished",
    "generations-started",
    "generations-finished",
    "lifecycle-planning-started",
    "lifecycle-planning-finished",
    "archive-materialization-started",
    "archive-materialization-finished",
    "lifecycle-transaction-started",
    "lifecycle-transaction-finished",
    "lifecycle-prepared-write-finished",
    "archive-publication-started",
    "archive-publication-finished",
    "reinventory-started",
    "reinventory-finished",
  ]);
  let remainingPhases = 64;
  const observeRepairPhase = (message: unknown): void => {
    if (remainingPhases > 0 && typeof message === "string" && knownRepairPhases.has(message)) {
      remainingPhases -= 1;
      markPhase(message);
    }
  };
  if (mode === "apply") {
    channel("openclaw.doctor.canonical-repair").subscribe(observeRepairPhase);
  }
  markPhase("child-entered");
  const { repairCanonicalSessionKeys } =
    await import("./doctor-session-canonical-keys.test-support.js");
  markPhase("repair-imported");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const result = await repairCanonicalSessionKeys(
    {
      apply: mode === "apply",
      cfg: {
        agents: { entries: { main: {} } },
        session: { store: storeTemplate },
      },
      env,
    },
    markPhase,
  ).finally(() => {
    channel("openclaw.doctor.canonical-repair").unsubscribe(observeRepairPhase);
  });
  // The 160 MiB proof covers repair and result serialization, not unrelated Node shutdown tasks.
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

// Node resolves the bundle through shared node_modules; compare canonical paths.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
