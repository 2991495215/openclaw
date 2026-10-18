import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import {
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import type { runCronSessionTurn } from "./session-run.js";
import { cronStoreKey } from "./store/key.js";

it("records a pending main-session event as interrupted across restart without replaying it", async () => {
  await withOpenClawTestState(
    { label: "cron-session-restart", env: { OPENCLAW_TEST_FAST: "0" } },
    async (fixture) => {
      const sessionKey = "agent:main:main";
      const sessionStorePath = resolveSessionStorePathCore(undefined, {
        agentId: "main",
        env: fixture.env,
      });
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { skipBootstrap: true, workspace: fixture.workspaceDir },
          entries: { main: {} },
        },
        session: { store: sessionStorePath },
        plugins: { enabled: false },
        skills: { load: { watch: false } },
      };
      setRuntimeConfigSnapshot(cfg);
      openOpenClawStateDatabase({ env: fixture.env });
      writeSessionEntry(
        openOpenClawAgentDatabase({ agentId: "main", env: fixture.env }),
        sessionKey,
        {
          sessionId: "cron-main-restart-session",
          lifecycleRevision: "cron-main-restart-revision",
          updatedAt: Date.now(),
          permissionMode: "full",
        },
      );
      resetSystemEventsForTest();
      resetGatewayWorkAdmission();

      // A real earlier input holds FIFO admission before the scheduled event is adopted.
      const predecessor = reserveSessionControllerSource(sessionKey, {
        policy: { mode: "followup" },
        target: captureSessionTarget({ storeScope: sessionStorePath, sessionKey, agentId: "main" }),
      });
      const pending = createDeferred();
      const observePending = () => {
        if (
          predecessor.mailbox.entries.length > 1 &&
          peekSystemEventEntries(sessionKey).length === 1
        ) {
          pending.resolve();
        }
      };
      const unsubscribe = onGatewayWorkMetricsChanged(observePending);
      const storePath = fixture.statePath("cron", "jobs.json");
      const enqueueSystemEvent: CronServiceDeps["enqueueSystemEvent"] = (text, options) => {
        const remove = enqueueSystemEventWithReceipt(text, {
          sessionKey,
          contextKey: options?.contextKey,
        });
        return remove ? { accepted: true, remove } : { accepted: false };
      };
      const runSessionEvent = vi.fn(
        async (
          request: Omit<Parameters<typeof runCronSessionTurn>[0], "cfg" | "agentId" | "sessionKey">,
        ) => {
          // Main does not have this adapter. Import it only if the execution owner uses it.
          const modulePath = "./session-run.js";
          const { runCronSessionTurn: run } = (await import(modulePath)) as {
            runCronSessionTurn: typeof runCronSessionTurn;
          };
          return await run({ ...request, cfg, agentId: "main", sessionKey });
        },
      );
      const deps = {
        storePath,
        scheduler: createTestGatewayScheduler(),
        cronEnabled: true,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent,
        enqueueSessionEvent: vi.fn(),
        runSessionEvent,
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        onEvent: (event: { action: string }) => {
          // On main, wait for the durable false success before simulating restart.
          // On the migrated path, the mailbox observation resolves first.
          if (event.action === "finished") {
            pending.resolve();
          }
        },
      };
      const first = new CronService(deps);
      let replacement: CronService | undefined;
      let running: ReturnType<CronService["run"]> | undefined;
      try {
        await first.start();
        const job = await first.add({
          name: "Pending main-session reminder",
          enabled: false,
          deleteAfterRun: false,
          schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "Synthetic reminder pending at restart" },
        });
        const history = () =>
          readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
            .entries;
        running = first.run(job.id, "force");
        await pending.promise;
        expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
        expect(history()).toEqual([]);

        first.stop();
        // Restart retires the real waiting mailbox input before joining cron's receipt owner.
        markGatewayRestartDraining();
        resetSystemEventsForTest();
        await first.waitForIdle();
        await running;
        await predecessor.settlement.promise;
        await drainGlobalSingletonLifecycleState("restart");
        resetGatewayWorkAdmission();
        setRuntimeConfigSnapshot(cfg);

        replacement = new CronService({ ...deps, scheduler: createTestGatewayScheduler() });
        await replacement.start();
        const interrupted = history();
        expect(interrupted).toHaveLength(1);
        expect(interrupted[0]).toMatchObject({ status: "error" });
        expect((await replacement.readJob(job.id))?.state.lastRunStatus).toBe("error");
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        expect(deps.runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(runSessionEvent).toHaveBeenCalledOnce();

        replacement.stop();
        await replacement.waitForIdle();
        await replacement.start();
        expect(history()).toEqual(interrupted);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        expect(runSessionEvent).toHaveBeenCalledOnce();
      } finally {
        unsubscribe();
        first.stop();
        replacement?.stop();
        markGatewayRestartDraining();
        resetSystemEventsForTest();
        retireSessionControllerInput(predecessor);
        await Promise.allSettled([
          running,
          first.waitForIdle(),
          replacement?.waitForIdle(),
          predecessor.settlement.promise,
        ]);
        resetGatewayWorkAdmission();
      }
    },
  );
});
