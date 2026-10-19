import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import {
  getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  requireValue,
  expectRecordFields,
  mockCallArg,
  flushScheduledDispatchStep,
  buildExistingMainStoreEntry,
  invokeAgent,
  prime,
} from "./agent.test-harness.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";

const mocks = getAgentTestMocks();
type HeldAgentResult = { payloads: Array<{ text: string }>; meta: { durationMs: number } };

export function registerAgentPreacceptAbortTests({
  captureAgentRunSettlement,
  expectPreparingAgentSource,
  expectMainAlias,
}: {
  captureAgentRunSettlement: (runId: string) => Promise<void>;
  expectPreparingAgentSource: (
    runId: string,
    identity: { sessionKey: string; sessionId: string; agentId: string },
  ) => RpcSourceRef;
  expectMainAlias: (payload: unknown, runId: string, alias: string) => void;
}) {
  it.each(["session write", "runtime acquisition"] as const)(
    "does not dispatch when chat.abort lands during pre-accept %s",
    async (boundary) => {
      prime();
      const requestedSessionKey = "agent:main:legacy-main";
      const setupStarted = createDeferred();
      const releaseSetup = createDeferred();
      let sessionWriteCalls = 0;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        sessionWriteCalls += 1;
        if (boundary === "session write" && sessionWriteCalls === 1) {
          setupStarted.resolve();
          await releaseSetup.promise;
        }
        const store = {
          "agent:main:main": buildExistingMainStoreEntry(),
        };
        return await updater(store);
      });
      if (boundary === "runtime acquisition") {
        const runtime = await import("../../agents/prepared-model-runtime.js");
        const acquire = vi.mocked(runtime.acquireAgentRunPreparedModelRuntime);
        const createLease = requireValue(acquire.getMockImplementation(), "model lease fixture");
        acquire.mockImplementationOnce(async (...args) => {
          setupStarted.resolve();
          await releaseSetup.promise;
          return createLease(...args);
        });
      }
      const agentResult = createDeferred<HeldAgentResult>();
      mocks.agentCommand.mockReturnValueOnce(agentResult.promise);

      const context = makeContext();
      const respond = vi.fn();
      const ownerClient = { ...operatorWriteCliClient(), connId: "preaccept-owner" };
      const runId = "idem-abort-before-registration";
      const pending = invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: requestedSessionKey,
          idempotencyKey: runId,
        },
        { context, respond, client: ownerClient, reqId: runId, flushDispatch: false },
      );
      let cancellation: Promise<void> | undefined;
      try {
        await setupStarted.promise;
        const source = expectPreparingAgentSource(runId, {
          sessionKey: "agent:main:main",
          sessionId: "existing-session-id",
          agentId: "main",
        });
        expectMainAlias(context.dedupe.get(`agent:${runId}`)?.payload, runId, requestedSessionKey);

        const abortRespond = vi.fn();
        cancellation = handleChatAbortRequest({
          params: { sessionKey: requestedSessionKey, runId },
          respond: abortRespond as never,
          context,
          req: { type: "req", id: "abort-req", method: "chat.abort" },
          client: ownerClient,
          isWebchatConnect: () => false,
        });
        await cancellation;
        expect(source.input.abortSignal.aborted).toBe(true);
        expect(rpcSourceTesting.get(runId)).toBe(source);
        expect(mockCallArg(abortRespond)).toBe(true);
        expectRecordFields(mockCallArg(abortRespond, 0, 1), {
          aborted: true,
          runIds: [runId],
        });

        expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
          runId,
          sessionKey: requestedSessionKey,
          status: "timeout",
          summary: "aborted",
          stopReason: "rpc",
        });

        releaseSetup.resolve();
        await pending;
        await flushScheduledDispatchStep();

        expect(mocks.agentCommand).not.toHaveBeenCalled();
        expect(rpcSourceTesting.has(runId)).toBe(false);
        const finalResponse = respond.mock.calls.find(
          (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
        );
        expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
          runId,
          status: "timeout",
          stopReason: "rpc",
          timeoutPhase: "queue",
          providerStarted: false,
        });
      } finally {
        const settlement = captureAgentRunSettlement(runId);
        agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
        releaseSetup.resolve();
        await Promise.allSettled([pending, cancellation]);
        await flushScheduledDispatchStep();
        await settlement;
        await captureAgentRunSettlement(runId);
      }
    },
  );
}
