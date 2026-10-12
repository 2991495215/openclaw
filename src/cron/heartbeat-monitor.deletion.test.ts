import { expect, it, vi } from "vitest";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deleteAgentConfigEntry } from "../gateway/server-methods/agents-config-mutations.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { applyHeartbeatMonitorJobs } from "./heartbeat-monitor.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";

it("reports a deletion-blocked monitor until the accepted roster catches up", async () => {
  await withOpenClawTestState({ label: "heartbeat-monitor-deletion" }, async (state) => {
    let runtimeConfig: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { heartbeat: { every: "0m" } },
        entries: {
          survivor: { workspace: state.path("survivor") },
          doomed: { workspace: state.path("doomed") },
        },
      },
    };
    await state.writeConfig(runtimeConfig);
    const clock = createGatewaySchedulerClock(Date.parse("2026-10-10T00:00:00Z"));
    const scheduler = createTestGatewayScheduler(clock.clock);
    const logger = createNoopLogger();
    const cron = new CronService({
      scheduler,
      nowMs: clock.clock.now,
      log: logger,
      storePath: state.statePath("cron", "jobs.json"),
      cronEnabled: false,
      defaultAgentId: "survivor",
      // Model the accepted roster; the real worker owns the deletion check.
      isAgentAvailable: (agentId) => Boolean(runtimeConfig.agents?.entries?.[agentId]),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const reconcile = () =>
      applyHeartbeatMonitorJobs({
        cron,
        cfg: runtimeConfig,
        schedulerSeed: "test-seed",
        logger,
      });
    try {
      expect((await reconcile()).ok).toBe(true);
      const initialJobs = await cron.list({ includeDisabled: true });
      expect(initialJobs).toHaveLength(2);
      expect(initialJobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentId: "survivor", enabled: false }),
          expect.objectContaining({ agentId: "doomed", enabled: false }),
        ]),
      );
      await withAgentDeletion(
        "doomed",
        async (begin) => {
          const deletion = await begin({
            agentId: "doomed",
            agentDir: state.agentDir("doomed"),
            workspaceDir: state.path("doomed"),
            sessionsDir: state.sessionsDir("doomed"),
            deleteFiles: false,
            phase: "draining",
          });
          try {
            const committed = await cron.removeAgentJobsTransactional("doomed", () =>
              deleteAgentConfigEntry({
                agentId: "doomed",
                assertCurrent: deletion.assertCurrentFinal,
                assertCurrentAsync: deletion.assertCurrentAsync,
                allowConfigSizeDrop: true,
              }),
            );
            expect(committed.nextConfig.agents?.entries?.doomed).toBeUndefined();

            // Keep the previously accepted runtime roster while source deletion is committed.
            const stale = await reconcile();
            expect(stale.ok).toBe(false);
            expect(stale.failures).toEqual([
              {
                change: expect.objectContaining({ kind: "create", agentId: "doomed" }),
                error: expect.objectContaining({
                  message: "cron job agent is unavailable: doomed",
                }),
              },
            ]);
            expect(logger.warn).toHaveBeenCalledWith(
              { agentId: "doomed", err: "Error: cron job agent is unavailable: doomed" },
              "cron-heartbeat: monitor convergence failed",
            );
            expect(await cron.list({ includeDisabled: true })).toEqual([
              expect.objectContaining({ agentId: "survivor", enabled: false }),
            ]);

            runtimeConfig = committed.nextConfig;
            expect(await reconcile()).toEqual({ ok: true, applied: [], failures: [] });
            expect(await cron.list({ includeDisabled: true })).toEqual([
              expect.objectContaining({ agentId: "survivor", enabled: false }),
            ]);
          } finally {
            await deletion.rollback();
          }
        },
        { env: state.env },
      );
    } finally {
      cron.stop();
      await cron.waitForIdle();
      await scheduler.stop();
    }
  });
});
