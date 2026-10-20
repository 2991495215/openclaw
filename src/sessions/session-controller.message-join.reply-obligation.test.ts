import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { bindWorkerToolPreparation } from "../agents/harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../agents/harness/tool-authority-preparation.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import {
  resolveReplyExpectation,
  shouldDeliverMissingReplyNotice,
} from "../agents/reply-completion.js";
import {
  withMessageInjectionAdmission,
  MessageInjectionAcceptedUnconfirmedError,
  MessageInjectionTargetUnavailableError,
} from "../auto-reply/reply/message-injection-authority.js";
import { prepareReplyToolAuthority } from "../auto-reply/reply/reply-tool-authority.js";
import {
  createQueueTestRun,
  toolAuthorityOverlay,
} from "../auto-reply/reply/reply-tool-authority.test-support.js";
import { prepareSteeringDelivery } from "../auto-reply/reply/steering-delivery-preparation.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  registerSubagentCompletionToolHandoff,
  consumeSubagentCompletionToolHandoff,
} from "../gateway/subagent-completion-tool-handoff.js";
import { registerAgentRunContext, clearAgentRunContext } from "../infra/agent-run-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { captureReplyExecutionSelection } from "./session-controller.execution-selection.js";
import {
  beginReplyMessageInjectionTarget,
  captureReplyMessageInjectionTarget,
} from "./session-controller.message-injection.js";
import { prepareReplyMessageContinuation } from "./session-controller.message-join.js";
import { readReplyOperationReplyAccounting } from "./session-controller.reply-accounting.js";
import { testing } from "./session-controller.test-support.js";

const dirs = useSessionStoreTempDirs(afterAll, "openclaw-accepted-reply-handoff-");
const sessionId = "accepted-reply-parent";
const sessionKey = "agent:main:accepted-reply-parent";
const runId = "accepted-reply-owner";
const attempt = { provider: "openai", modelId: "synthetic-model" };
afterEach(() => {
  testing.resetSessionControllerForTest();
  clearRuntimeConfigSnapshot();
  clearAgentRunContext(runId);
});
it.each([
  "required",
  "result-required",
  "withheld-ack",
  "rejected",
  "ack-unconfirmed",
  "uncertain-without-ack",
  "fulfilled-without-callback",
  "monotone",
  "lower-scopes",
  "wrong-policy",
  "hidden",
  "unbound-owner",
] as const)(
  "records only proven accepted human obligations through canonical handoff admission: %s",
  async (scenario) => {
    const storePath = path.join(dirs.make(), "sessions.json");
    const config = { session: { store: storePath }, tools: { allow: ["read", "exec"] } };
    setRuntimeConfigSnapshot(config);
    const sourceSessionKeys = [
      "agent:main:subagent:synthetic-first",
      "agent:main:subagent:synthetic-second",
    ] as const;
    await replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: 1 });
    for (const key of sourceSessionKeys) {
      await replaceSessionEntry(
        { storePath, sessionKey: key },
        {
          sessionId: key + "-session",
          updatedAt: 1,
          spawnedBy: sessionKey,
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: ["read", "exec"],
          inheritedToolDeny: [],
        },
      );
    }
    const current = true;
    const registration = {
      sourceSessionKey: sourceSessionKeys[0],
      targetSessionKey: sessionKey,
      targetSessionId: sessionId,
      idempotencyKey: "synthetic-settle-batch",
      settleBatch: { sourceSessionKeys, isCurrent: () => current },
    };
    const trustedInternalHandoff = consumeSubagentCompletionToolHandoff({
      ...registration,
      handoffId: registerSubagentCompletionToolHandoff(registration),
      sourceTool: "subagent_settle",
      provider: attempt.provider,
      model: attempt.modelId,
    });
    expect(trustedInternalHandoff).toBeDefined();
    const inputProvenance = {
      kind: "inter_session" as const,
      sourceTool: "subagent_settle",
      sourceSessionKey: sourceSessionKeys[0],
    };

    const entry: SessionEntry = { sessionId, updatedAt: 1 };
    const modelPolicy = prepareOperatorModelPolicy({ cfg: config, policy: {} });
    const authority = (incoming = false) =>
      createAdmittedRunOperatorAuthority({
        profileId: "accepted-reply-owner",
        gatewayAccessGrant: null,
        modelPolicy,
        scopes: incoming && scenario === "lower-scopes" ? ["operator.read"] : ["operator.admin"],
        assertCurrent() {},
      });
    const incumbent = createQueueTestRun({
      prompt: "Synthetic completion",
      originatingChannel: "webchat",
    });
    incumbent.operatorAuthority = authority();
    Object.assign(incumbent.run, {
      runId,
      config,
      agentId: "main",
      sessionId,
      sessionKey,
      sessionFile: path.join(path.dirname(storePath), "synthetic.jsonl"),
      workspaceDir: path.dirname(storePath),
      provider: attempt.provider,
      model: attempt.modelId,
      messageProvider: "webchat",
      chatType: "direct",
      senderIsOwner: true,
      traceAuthorized: false,
      clientCaps: [],
      inputProvenance,
      trustedInternalHandoff,
      terminalReplyExpectation: "optional",
    });
    const selection = captureReplyExecutionSelection({ run: incumbent.run, sessionEntry: entry });
    await withSessionTurn(
      { sessionKey, sessionId, agentId: "main", storePath },
      async (operation) => {
        if (!operation) {
          throw new Error("Expected canonical completion owner");
        }
        const accounting = readReplyOperationReplyAccounting(operation);
        if (!accounting) {
          throw new Error("Expected private accounting state");
        }
        // Owner-level stand-in for the actual core lane-controller binding, NOT full-runner proof.
        if (scenario !== "unbound-owner") {
          accounting.bindHostTerminalOwner();
        }
        const record = vi.spyOn(accounting, "recordAcceptedHumanReply");
        await operation.bindToolAuthoritySnapshotAsync(
          prepareReplyToolAuthority({ ...incumbent, executionSelection: selection }),
        );
        const fingerprint = await operation.bindToolAuthorityRouteAsync(incumbent.run);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const sink = vi.fn();
        operation.attachBackend({
          kind: "embedded",
          runId,
          toolAuthorityFingerprint: fingerprint,
          terminalReplyExpectation: "optional",
          cancel() {},
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            async queueMessage() {
              throw new Error("Expected prepared owner dispatch");
            },
            async queueMessageAsync(text, options, preparation) {
              entered.resolve();
              await release.promise;
              if (scenario === "rejected") {
                throw new MessageInjectionTargetUnavailableError(
                  "Synthetic target closed before acceptance",
                );
              }
              if (scenario === "uncertain-without-ack") {
                throw new MessageInjectionAcceptedUnconfirmedError();
              }
              await withMessageInjectionAdmission(preparation.prepareCurrent, () => {
                preparation.assertCurrent();
                sink(text);
                if (scenario !== "fulfilled-without-callback") {
                  options?.onQueueAccepted?.(true);
                  options?.onQueueAccepted?.(true); // Real duplicate positive notification must be idempotent.
                }
              });
              if (scenario === "ack-unconfirmed") {
                throw new MessageInjectionAcceptedUnconfirmedError();
              }
            },
          },
        });
        operation.setPhase("running");
        if (scenario === "hidden") {
          registerAgentRunContext(runId, {
            isControlUiVisible: false,
            projectSessionMessages: false,
          });
        }
        const target = captureReplyMessageInjectionTarget(operation);
        if (!target) {
          throw new Error("Expected captured completion target");
        }
        const incoming: typeof incumbent = {
          ...incumbent,
          operatorAuthority: authority(true),
          prompt: "Synthetic human correction",
          run: { ...incumbent.run, inputProvenance: undefined, trustedInternalHandoff: undefined },
        };
        if (scenario === "wrong-policy") {
          incoming.run.config = { ...config, tools: { allow: ["read"] } };
        }
        const {
          traceAuthorized: _trace,
          allowCollaborativeSteering: _collaboration,
          ...caller
        } = toolAuthorityOverlay(incoming);
        const delivery = prepareSteeringDelivery({
          agentId: "main",
          sessionKey,
          sessionId,
          storePath,
          entry,
          assertCurrent: () => incoming.operatorAuthority?.assertCurrent(),
        });
        const joined = await prepareReplyMessageContinuation({
          target,
          assertCurrent: () => incoming.operatorAuthority?.assertCurrent(),
          input: {
            kind: "continuation",
            caller,
            config: incoming.run.config,
            executionSelection: selection,
            delivery,
            selectedRoute: { provider: attempt.provider, model: attempt.modelId },
            fallbackAvailability: { kind: "none_configured", source: "inherited" },
          },
        });
        try {
          expect(accounting.acceptedHumanReplyExpectation).toBeUndefined();
          const terminal = { ...incumbent.run, replyOperation: operation };
          expect(resolveReplyExpectation(terminal)).toBe("optional");
          expect(shouldDeliverMissingReplyNotice(terminal)).toBe(false);
          if (scenario === "wrong-policy" || scenario === "lower-scopes") {
            expect(joined.kind).not.toBe("prepared");
            expect(sink).not.toHaveBeenCalled();
            expect(record).not.toHaveBeenCalled();
            return;
          }
          expect(joined.kind).toBe("prepared");
          if (joined.kind !== "prepared") {
            throw new Error("Expected private human continuation");
          }
          const inject = (expectation: "required" | "result-required" | "optional") =>
            beginReplyMessageInjectionTarget(target, incoming.prompt, {
              isInboundUserMessage: true,
              terminalReplyExpectation: expectation,
              toolAuthorityFingerprint: joined.fingerprint,
              assertCurrent: () => incoming.operatorAuthority?.assertCurrent(),
              toolAuthorityPreparation: bindPreparedToolAuthority(
                bindWorkerToolPreparation({
                  authorityKind: "source-bound" as const,
                  assertCurrent: () => joined.read(),
                  compatAssertCurrent: () => joined.read(),
                  prepareCurrent: joined.prepareCurrent,
                }),
              ),
            });
          const expectation = scenario === "result-required" ? "result-required" : "required";
          const injection = await inject(expectation);
          if (scenario === "hidden" || scenario === "unbound-owner") {
            await expect(injection.outcome).resolves.toMatchObject({
              status: "rejected",
              reason:
                scenario === "hidden" ? "input_visibility_mismatch" : "reply_expectation_mismatch",
            });
            expect(await injection.acceptance).toBe(false);
            expect(sink).not.toHaveBeenCalled();
            expect(record).not.toHaveBeenCalled();
            return;
          }
          await entered.promise;
          // Every ordinary positive case is held AFTER real preparation and BEFORE runtime acceptance.
          expect(accounting.acceptedHumanReplyExpectation).toBeUndefined();
          expect(resolveReplyExpectation(terminal)).toBe("optional");
          expect(record).not.toHaveBeenCalled();
          expect(sink).not.toHaveBeenCalled();
          release.resolve();
          const outcome = await injection.outcome;
          const uncertain = scenario === "ack-unconfirmed" || scenario === "uncertain-without-ack";
          expect(outcome.status).toBe(
            scenario === "rejected" ? "rejected" : uncertain ? "indeterminate" : "accepted",
          );
          const acknowledged = scenario !== "rejected" && scenario !== "uncertain-without-ack";
          expect(await injection.acceptance).toBe(scenario !== "rejected");
          expect(accounting.acceptedHumanReplyExpectation).toBe(
            acknowledged ? expectation : undefined,
          );
          expect(record).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
          expect(sink).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
          expect(resolveReplyExpectation(terminal)).toBe(acknowledged ? expectation : "optional");
          expect(shouldDeliverMissingReplyNotice(terminal)).toBe(acknowledged);
          if (scenario === "monotone") {
            await expect((await inject("result-required")).outcome).resolves.toMatchObject({
              status: "accepted",
            });
            await expect((await inject("required")).outcome).resolves.toMatchObject({
              status: "accepted",
            });
            await expect((await inject("optional")).outcome).resolves.toMatchObject({
              status: "accepted",
            });
            expect(accounting.acceptedHumanReplyExpectation).toBe("result-required");
            expect(resolveReplyExpectation({ ...terminal })).toBe("result-required");
          }
          expect(incoming.run.inputProvenance).toBeUndefined();
          expect(incoming.run.trustedInternalHandoff).toBeUndefined();
        } finally {
          release.resolve();
          if (joined.kind === "prepared") {
            joined.release();
          }
          delivery.release();
        }
      },
    );
  },
);
