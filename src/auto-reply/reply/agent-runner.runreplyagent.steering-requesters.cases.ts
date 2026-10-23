import { expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { reserveSteerCandidate, scheduleFollowupDrain, type FollowupRun } from "./queue.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

type SteeringRequesterFixture = {
  createMinimalRun: (params: {
    opts?: InternalGetReplyOptions;
    isActive?: boolean;
    shouldSteer?: boolean;
    resolvedQueueMode?: string;
    runOverrides?: Partial<FollowupRun["run"]>;
    bindActiveAuthority?: boolean;
  }) => { followupRun: FollowupRun; run: () => Promise<unknown> };
  state: { backendQueueMessageMock: Mock; runEmbeddedAgentMock: Mock };
};

export function registerSteeringRequesterCases({
  createMinimalRun,
  state,
}: SteeringRequesterFixture): void {
  it.for([
    { reason: "privilege facts differ", missingRequester: false, collaboration: false },
    { reason: "the active requester is unknown", missingRequester: true, collaboration: false },
    {
      reason: "collaboration cannot identify the active requester",
      missingRequester: true,
      collaboration: true,
    },
  ])(
    "queues instead of steering when $reason",
    async ({ missingRequester, collaboration }, { signal }) => {
      const actualQueue = await vi.importActual<typeof import("./queue.js")>("./queue.js");
      const followupTasks: Promise<void>[] = [];
      const observeFollowup =
        (runFollowup: Parameters<typeof scheduleFollowupDrain>[1]) => (queued: FollowupRun) => {
          const task = runFollowup(queued);
          followupTasks.push(task.catch(() => {}));
          return task;
        };
      vi.mocked(reserveSteerCandidate).mockImplementation((key, queued, settings, runFollowup) =>
        actualQueue.reserveSteerCandidate(key, queued, settings, observeFollowup(runFollowup)),
      );
      vi.mocked(scheduleFollowupDrain).mockImplementation((key, runFollowup) =>
        actualQueue.scheduleFollowupDrain(key, observeFollowup(runFollowup)),
      );
      const queued = createDeferred();
      const onDeferred = vi.fn(() => queued.resolve());
      const settled = createDeferred();
      const onAdopted = vi.fn();
      const onBlockReply = vi.fn();
      const runState: ReplyOperationRunState = {};
      const active = createReplyOperation({
        sessionKey: "main",
        sessionId: "session",
        resetTriggered: false,
      });
      const { followupRun, run } = createMinimalRun({
        isActive: true,
        shouldSteer: true,
        resolvedQueueMode: "steer",
        runOverrides: {
          config: collaboration
            ? { messages: { queue: { allowCollaborativeSteering: true } } }
            : {},
        },
        bindActiveAuthority: false,
        opts: {
          [REPLY_OPERATION_RUN_STATE]: runState,
          onBlockReply,
          turnAdoptionLifecycle: {
            onAdopted,
            onDeferred,
            onSettled: settled.resolve,
          },
        },
      });
      await active.bindToolAuthoritySnapshotAsync(
        prepareReplyToolAuthority({
          ...followupRun,
          run: {
            ...followupRun.run,
            ...(missingRequester
              ? { senderId: undefined }
              : {
                  runtimePluginToolGrant: {
                    pluginId: "workboard",
                    toolNames: ["workboard_complete"],
                  },
                }),
          },
        }),
      );
      await active.bindToolAuthorityRouteAsync({ provider: "openai", model: "gpt-fallback" });
      active.setPhase("running");
      try {
        await expect(run()).resolves.toBeUndefined();
        await withinTest(
          awaitGateBeforeSettlement(
            queued.promise,
            settled.promise,
            "followup settled before queue acceptance",
          ),
          signal,
        );
        expect(onDeferred).toHaveBeenCalledOnce();
        expect(runState.admission).toEqual({
          status: "accepted",
          mode: "followup",
          reason: missingRequester ? "requester-mismatch" : "steering-unavailable",
        });
        expect(getExistingFollowupQueue("main")?.items).toEqual([followupRun]);
        expect(state.backendQueueMessageMock).not.toHaveBeenCalled();
        expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
        expect(onAdopted).not.toHaveBeenCalled();
        expect(onBlockReply).not.toHaveBeenCalled();

        active.complete();
        await withinTest(settled.promise, signal);
        await Promise.all(followupTasks);
        expect(onAdopted).toHaveBeenCalledOnce();
        expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
        expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
          prompt: "hello",
          senderId: followupRun.run.senderId,
        });
        expect(onBlockReply).toHaveBeenCalledOnce();
        expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ text: "final" }));
      } finally {
        active.complete();
        clearSessionQueues(["main"], getSessionControllerEntryForOperation(active).target);
        await Promise.all(followupTasks);
      }
    },
  );
}
