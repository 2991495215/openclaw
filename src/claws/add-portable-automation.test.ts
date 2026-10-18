import "../test-utils/prepare-compiled-subprocesses.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { applyClawAddPlanStateless } from "./add-stateless.js";
import { projectClawAddScheduledJobs } from "./gateway-disclosure.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { readClawManifestFile } from "./reader.js";

it.each(["5m", "0m"])(
  "adds portable heartbeat %s as ordinary jobs with scratch ready before enable",
  async (every) => {
    await withOpenClawTestState({ label: "claw-portable-add" }, async (fixture) => {
      const packageRoot = fixture.statePath("package");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "claw.json"),
        JSON.stringify({
          schemaVersion: 1,
          agent: { id: "portable", name: "Portable" },
          workspace: { bootstrapFiles: { "HEARTBEAT.md": { source: "HEARTBEAT.md" } } },
        }),
      );
      await writeFile(
        path.join(packageRoot, "HEARTBEAT.md"),
        "# Checklist\nCheck active incidents.\ntasks:\n- name: Summary\n  interval: 15m\n  prompt: Prepare a summary.\n",
      );
      const source = await readClawManifestFile(path.join(packageRoot, "claw.json"));
      if (!source.ok) {
        throw new Error(JSON.stringify(source.diagnostics));
      }
      let config: OpenClawConfig = {
        agents: { entries: { main: {} } },
        plugins: { enabled: false },
      };
      setRuntimeConfigSnapshot(config);
      const makePlan = () =>
        buildClawAddPlan({
          manifest: source.manifest,
          source: source.source,
          openClawProfile: { schemaVersion: 1, agent: { heartbeat: { every } } },
          context: { config, workspace: fixture.statePath("added-workspace") },
        });
      const plan = await makePlan();
      expect((await makePlan()).planIntegrity).toBe(plan.planIntegrity);
      expect(plan.agent.config).not.toHaveProperty("heartbeat");
      expect(projectClawAddScheduledJobs(plan).jobs.map((job) => job.proposed)).toEqual([
        expect.objectContaining({
          schedule: { everyMs: every === "0m" ? 1_800_000 : 300_000 },
          delivery: "owner",
          session: "main",
        }),
        expect.objectContaining({
          schedule: { everyMs: 900_000 },
          delivery: "owner",
          message: "Prepare a summary.",
        }),
      ]);
      const run = vi.fn(async () => ({ status: "ok" as const }));
      const cron = new CronService({
        storePath: fixture.statePath("cron", "jobs.json"),
        scheduler: createTestGatewayScheduler(),
        cronEnabled: true,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runSessionEvent: run,
        runIsolatedAgentJob: run,
      });
      await cron.start();
      try {
        const result = await applyClawAddPlanStateless(plan, {
          config,
          consentPlanIntegrity: plan.planIntegrity,
          getCurrentConfig: () => config,
          commitConfig: async (transform) => {
            config = transform(config);
            setRuntimeConfigSnapshot(config);
          },
          cronGateway: {
            add: async (input, options) => {
              const normalized = normalizeCronJobCreate(input);
              if (!normalized) {
                throw new Error("invalid cron input");
              }
              return await cron.add(normalized, { commitGuard: options?.commitGuard });
            },
            list: async () => ({ jobs: await cron.list({ includeDisabled: true }) }),
            get: async (id) => {
              const job = await cron.readJob(id);
              return job && { ...job, configRevision: resolveCronJobConfigRevision(job) };
            },
            writeScratch: async (id, content, commitGuard) => {
              expect((await cron.readJob(id))?.enabled).toBe(false);
              expect(await cron.run(id, "due")).toMatchObject({ ran: false });
              expect(run).not.toHaveBeenCalled();
              const outcome = await cron.writeScratch(id, {
                content,
                expectedRevision: 0,
                commitGuard,
              });
              expect(outcome.ok).toBe(true);
            },
            enable: async (id, revision, commitGuard) => {
              expect((await cron.readScratch(id)).scratch?.content).toBe(
                "# Checklist\nCheck active incidents.\n",
              );
              await cron.updateWithPrecondition(
                id,
                { enabled: true },
                (job) => {
                  expect(resolveCronJobConfigRevision(job)).toBe(revision);
                },
                { commitGuard },
              );
            },
          },
        });
        expect(result.status, result.error?.message).toBe("complete");
        const jobs = await cron.list({ includeDisabled: true });
        expect(jobs).toHaveLength(2);
        expect(jobs.every((job) => job.enabled === (every !== "0m"))).toBe(true);
        expect(jobs.find((job) => job.name === "Summary")?.payload).toMatchObject({
          kind: "agentTurn",
          message: "Prepare a summary.",
        });
        const monitor = jobs.find((job) => job.name !== "Summary")!;
        expect((await cron.readScratch(monitor.id)).scratch?.content).toBe(
          "# Checklist\nCheck active incidents.\n",
        );
      } finally {
        cron.stop();
        await cron.waitForIdle();
      }
    });
  },
);
