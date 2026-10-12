import type { AgentHarnessSideQuestionParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { createCodexInferenceModelBinding } from "./inference-dispatch.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { isJsonObject } from "./protocol.js";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { sessionBindingIdentity } from "./session-binding.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import { runCodexAppServerSideQuestion } from "./side-question.js";

setupRunAttemptTestHooks();
afterAll(clearRuntimeConfigSnapshot);

describe("active parent session fork", () => {
  it("uses the recorded parent client and settings across differing acquisition keys", async () => {
    let inferenceAdmitted = false;
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "thread/fork") {
          return threadStartResult("fork-thread");
        }
        if (
          method === "turn/start" &&
          isJsonObject(request) &&
          request.threadId === "fork-thread"
        ) {
          void (async () => {
            try {
              const execution = await createCodexInferenceModelBinding({
                client: harness.client,
                provider: "openai",
                assertCurrent: () => {},
                memoryConfigured: () => false,
                captureModelSource: codexNativeSubagentMonitorRuntime.captureModelSource,
                resolveModelThreadId: codexNativeSubagentMonitorRuntime.resolveModelThreadId,
              })({
                path: "/responses",
                body: { model: "gpt-5" },
                headers: {},
                metadata: { threadId: "fork-thread", turnId: "fork-turn", requestKind: "turn" },
                transport: "http",
                signal: new AbortController().signal,
              });
              execution.assertCurrent();
              inferenceAdmitted = true;
              execution.release();
            } finally {
              await harness.notify({
                method: "turn/completed",
                params: {
                  threadId: "fork-thread",
                  turn: {
                    id: "fork-turn",
                    status: "completed",
                    items: [{ id: "fork-answer", type: "agentMessage", text: "Read-only review." }],
                  },
                },
              });
            }
          })().catch(() => {});
          return turnStartResult("fork-turn");
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const params = createTestParams();
    setRuntimeConfigSnapshot(params.config ?? {});
    const parent = runCodexAppServerAttempt(params);
    await parent.waitForTurnAccepted();
    const binding = testCodexAppServerBindingStore.read(
      sessionBindingIdentity({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      }),
    );
    expect(binding?.clientId).toBe(harness.client.getInstanceId());
    // The parent used native-auth fixture keys; the side request below prepares an API-key route.
    // A fresh key-based acquisition must not replace the bound physical owner.
    const start = vi
      .spyOn(CodexAppServerClient, "start")
      .mockClear()
      .mockRejectedValue(new Error("Session fork attempted to acquire a replacement client"));
    const host = await createAdmittedHostCapabilityTestFixture(
      { runId: "session-fork" },
      { toolCalls: "deny" },
    );
    const side: AgentHarnessSideQuestionParamsV2 = {
      cfg: params.config ?? {},
      agentDir: params.agentDir ?? params.workspaceDir,
      agentId: params.agentId,
      provider: "openai",
      model: params.modelId,
      runtimeModel: params.model,
      question: "Review the active task without executing tools.",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      sessionEntry: { sessionId: params.sessionId, updatedAt: 1 },
      workspaceDir: params.workspaceDir,
      resolvedReasoningLevel: "off",
      isNewSession: false,
      toolCalls: "deny",
      hostCapabilities: host.hostCapabilities,
      opts: { runId: "session-fork" },
      preparedRuntimeAuth: {
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          selectedAuthMode: "api-key",
          modelRoute: {
            provider: "openai",
            modelId: params.modelId,
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            authRequirement: "api-key",
            requestTransportOverrides: "none",
          },
        },
        authProfileStore: params.authProfileStore ?? { version: 1, profiles: {} },
        authStorage: params.authStorage,
        modelRegistry: params.modelRegistry,
        resolvedApiKey: "synthetic-fork-key",
      },
    };
    try {
      await expect(
        runCodexAppServerSideQuestion(side, {
          bindingStore: testCodexAppServerBindingStore,
          nativeHookRelay: { enabled: true },
        }),
      ).resolves.toMatchObject({ text: "Read-only review." });
      expect(start).not.toHaveBeenCalled();
      expect(inferenceAdmitted).toBe(true);
      expect(
        await codexNativeSubagentMonitorRuntime.captureModelSource({
          client: harness.client,
          threadId: "fork-thread",
          turnId: "fork-turn",
        }),
      ).toBeUndefined();
      const parentStart = harness.requests.find(({ method }) => method === "thread/start");
      const fork = harness.requests.find(({ method }) => method === "thread/fork");
      if (!isJsonObject(parentStart?.params) || !isJsonObject(fork?.params)) {
        throw new Error("Expected real parent startup and side fork requests");
      }
      expect(fork.params.developerInstructions).toBe(parentStart.params.developerInstructions);
      expect(fork.params.threadId).toBe(binding?.threadId);
      expect(harness.client.getCloseError()).toBeUndefined();
    } finally {
      await harness.completeTurn({ threadId: binding?.threadId ?? "thread-1", turnId: "turn-1" });
      await parent;
      host.closeHost();
      host.closeAdmission();
    }
  });
});
