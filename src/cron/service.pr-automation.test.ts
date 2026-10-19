import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import {
  SESSION,
  SESSION_ID,
  stateDir,
  installRequesterCronAuthorityTestHooks,
} from "../gateway/server-methods/requester-cron-authority.test-support.js";
import { sessionMutationHandlers } from "../gateway/server-methods/sessions-mutations.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  ensureAgentWorkspaceMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";
import {
  createPrAutomationFixture,
  prAutomationSessionAccessor as accessor,
  readPrAutomationRecipeTarget,
} from "./service.pr-automation.test-support.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { resolveAgentDir } = await import("./isolated-agent/run.runtime.js");
const session = await vi.importActual<typeof import("./isolated-agent/session.js")>(
  "./isolated-agent/session.js",
);
const patchSession = expectDefined(sessionMutationHandlers["sessions.patch"], "sessions.patch");
const replacementSession = "replacement-session";
const agentResult = () => ({
  payloads: [{ text: "Synthetic request settled" }],
  meta: { agentMeta: {} },
});
installRequesterCronAuthorityTestHooks();
beforeEach(() => {
  resetRunCronIsolatedAgentTurnHarness();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  resolveCronSessionMock.mockImplementation(session.prepareCronSession);
  loadSessionEntryMock.mockImplementation(session.loadCronSessionEntryLatest);
  patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
  ensureAgentWorkspaceMock.mockImplementation(async ({ dir }: { dir: string }) => ({ dir }));
  resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  mockRunCronFallbackPassthrough();
});

it.each([false, true])(
  "existing archive API checks the scheduled recipe's exact identity (replaced=%s)",
  async (replaced) => {
    await persistAuthProfileBatch({
      stateDir,
      profiles: [
        {
          profileId: "openai:recipe-fixture",
          credential: {
            type: "api_key",
            provider: "openai",
            key: "synthetic-recipe-inference-key",
          },
        },
      ],
    });
    vi.mocked(resolveAgentDir).mockReturnValue(path.join(stateDir, "agents", "main", "agent"));
    const fixture = await createPrAutomationFixture(
      "autoArchive",
      (config) => ({
        runIsolatedAgentJob: (request) =>
          runCronIsolatedAgentTurn({
            ...request,
            cfg: config,
            deps: {},
            agentId: "main",
            sessionKey:
              resolveCronSessionTargetSessionKey(request.job.sessionTarget) ??
              `cron:${request.job.id}`,
          }),
      }),
      { defaults: { model: "openai/gpt-4.1" } },
    );
    const respond = vi.fn();
    const releaseCore = createDeferredCore();
    const releaseArchiveEffects = createDeferredCore();
    const cron = fixture.creator.context.cron;
    const updateWithPrecondition = cron.updateWithPrecondition.bind(cron);
    const archiveUpdate = !replaced
      ? vi.spyOn(cron, "updateWithPrecondition").mockImplementation(async (...args) => {
          const result = await updateWithPrecondition(...args);
          // Hold the archive handler after the real worker commit and cancellation.
          await releaseArchiveEffects.promise;
          return result;
        })
      : undefined;
    let archiveRequest: Promise<void> | undefined;
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      const target = readPrAutomationRecipeTarget(params.prompt);
      const patch = {
        key: target.sessionKey,
        expectedSessionId: expectDefined(target.sessionId, "archive incarnation"),
        archived: true,
      };
      archiveRequest = Promise.resolve(
        patchSession({
          req: { type: "req", id: "recipe-archive", method: "sessions.patch", params: patch },
          params: patch,
          respond,
          context: fixture.creator.context,
          client: fixture.client,
          isWebchatConnect: () => false,
        }),
      );
      await archiveRequest;
      if (!replaced) {
        await releaseCore.promise;
      }
      return agentResult();
    });
    try {
      if (replaced) {
        await fixture.seed(replacementSession);
      }
      await fixture.execution.update(fixture.selected.id, { enabled: true });
      const event = await fixture.tick();
      releaseArchiveEffects.resolve();
      // Archive commits before cancellation settles the occurrence and RPC.
      expect(event).toMatchObject({
        jobId: fixture.selected.id,
        ...(replaced
          ? { status: "ok" }
          : { status: "error", error: "Cron job disabled by operator." }),
      });
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      await expectDefined(archiveRequest, "archive request");
      const stored = accessor.loadSessionEntry({ agentId: "main", sessionKey: SESSION });
      if (replaced) {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ details: { reason: "session-changed" } }),
        );
        expect(stored).toMatchObject({ sessionId: replacementSession });
        expect(stored?.archivedAt).toBeUndefined();
      } else {
        expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect(stored).toMatchObject({ sessionId: SESSION_ID, archivedAt: expect.any(Number) });
        const stopped = vi.fn();
        const teardown = fixture.stop().then(stopped);
        // Keep the core held across a worker round-trip before checking teardown.
        expect((await fixture.creator.read()).every((job) => !job.enabled)).toBe(true);
        expect(stopped).not.toHaveBeenCalled();
        releaseCore.resolve();
        await teardown;
        expect(stopped).toHaveBeenCalledOnce();
      }
    } finally {
      releaseArchiveEffects.resolve();
      releaseCore.resolve();
      await fixture.stop();
      archiveUpdate?.mockRestore();
    }
  },
);
