import path from "node:path";
import { prepareConversationTurnContextContract } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import * as clientRuntime from "./client-runtime.js";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { getCodexInferenceThread, ownCodexInferenceClient } from "./inference-routing.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createParams,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { isCodexTurnContextHandoff } from "./test-support.js";
import { writeNativeCatalogFixture } from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();

async function persistStartedThreadCatalog(method: string, request: unknown, rolloutPath: string) {
  if (method !== "thread/start" || !isJsonObject(request)) {
    return undefined;
  }
  await writeNativeCatalogFixture(rolloutPath, "thread-1", request.dynamicTools);
  const response = threadStartResult("thread-1");
  return { ...response, thread: { ...response.thread, path: rolloutPath } };
}

it.each([true, false])(
  "restores complete current context after native compaction (relay=%s)",
  async (relay) => {
    // Codex 092d3acd (0.162.1): AdditionalContextStore::merge deduplicates the
    // complete {kind,value} entry; replace_compacted_history does not reset it.
    // Model those independent native states, not a cache cleared by the test.
    let cache: JsonObject = {};
    let history: JsonValue[] = [];
    let creationPolicy = "";
    let latestRequest: JsonObject = {};
    let historyRequestOffset = 0;

    const frames: JsonObject[] = [];
    const agentDir = path.join(tempDir, "compaction-agent");
    const codexHome = resolveCodexAppServerHomeDir(agentDir);
    const rolloutPath = path.join(codexHome, "sessions", "compaction-context.jsonl");
    const persistent = "Persistent synthetic operator policy.";
    const tail = "Unchanged conversation and delivery guidance α🙂. ".repeat(250);
    const snapshots = relay
      ? [`First section A.\n${tail}`, `First section A.\n${tail}`, `First section B.\n${tail}`, ""]
      : [`First section A.\n${tail}`, `First section A.\n${tail}`];
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "account/read") {
          return { account: { type: "apiKey" } };
        }
        if (!isJsonObject(request)) {
          return undefined;
        }
        if (method === "thread/start" || method === "thread/resume") {
          creationPolicy =
            typeof request.developerInstructions === "string" ? request.developerInstructions : "";
        }
        const started = await persistStartedThreadCatalog(method, request, rolloutPath);
        if (started) {
          return started;
        }

        if (method === "turn/start") {
          latestRequest = request;
          const next = isJsonObject(request.additionalContext) ? request.additionalContext : {};
          const changed = Object.entries(next).filter(
            ([key, value]) => JSON.stringify(cache[key]) !== JSON.stringify(value),
          );
          cache = next;
          // Native pre-sampling compaction happens AFTER merge, BEFORE new input is recorded.
          history = [
            { role: "developer", content: creationPolicy },
            { role: "user", content: "Compacted synthetic history." },
          ];
          history.push(...changed.map(([, value]) => ({ role: "developer", content: value })));
          historyRequestOffset = harness.requests.length;
        }
        return undefined;
      },
      { persistedThreads: [], codexHome },
    );
    if (relay) {
      ownCodexInferenceClient(harness.client);
    }
    const observe = () => {
      // The leased native fixture owns inject_items itself. Consume its actual
      // recorded wire writes rather than expecting the fallback responder to see them.
      for (const request of harness.requests.slice(historyRequestOffset)) {
        if (
          request.method === "thread/inject_items" &&
          isJsonObject(request.params) &&
          Array.isArray(request.params.items)
        ) {
          history.push(...request.params.items);
        }
      }
      historyRequestOffset = harness.requests.length;
      const body = { instructions: "Native model policy.", input: history };
      const route = getCodexInferenceThread(harness.client, "thread-1");
      if (!relay) {
        return body;
      }
      const generation = isJsonObject(latestRequest.responsesapiClientMetadata)
        ? latestRequest.responsesapiClientMetadata[CODEX_INFERENCE_GENERATION_KEY]
        : undefined;
      if (!route || typeof generation !== "string") {
        throw new Error("Missing admitted inference context");
      }
      const prepared = route.context.prepare(body, {
        requestKind: "turn",
        threadId: "thread-1",
        generation,
      });
      prepared.assertCurrent();
      return prepared.body;
    };
    let release = () => {};
    try {
      for (const [index, text] of snapshots.entries()) {
        const params = createParams(path.join(tempDir, "compaction-context.jsonl"), tempDir, {
          runId: `context-${index}`,
        });
        params.agentDir = agentDir;
        params.timeoutMs = 60_000;
        params.extraSystemPrompt = text ? `${text}\n\n${persistent}` : persistent;
        params.extraSystemPromptTurnContext = text ? { start: 0, text } : undefined;
        const compacted = createDeferred<void>();
        params.onAgentEvent = (event) => {
          if (event.stream === "compaction" && event.data.phase === "end") {
            compacted.resolve();
          }
        };
        const run = runCodexAppServerAttempt(params);
        await run.waitForTurnAccepted();
        if (index === 0 && relay) {
          release = protectCodexAppServerLiveThread(harness.client, "thread-1");
        }
        // The next inference must have current context before any host callback.
        frames.push(observe());
        // Mid-turn history replacement retains the native dedup cache too.
        await harness.notify(
          itemNotification("item/started", { type: "contextCompaction", id: `compact-${index}` }),
        );
        history = [
          { role: "developer", content: creationPolicy },
          { role: "user", content: "Compacted synthetic history." },
        ];
        historyRequestOffset = harness.requests.length;
        await harness.notify(
          itemNotification("item/completed", { type: "contextCompaction", id: `compact-${index}` }),
        );
        frames.push(observe());
        await Promise.race([
          compacted.promise,
          run.then(() => {
            throw new Error("Attempt ended before compaction projection");
          }),
        ]);
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await run;
      }
      expect(frames).toHaveLength(snapshots.length * 2);
      for (const [index, text] of snapshots.entries()) {
        for (const frame of frames.slice(index * 2, (index + 1) * 2)) {
          const payload = frame;
          if (typeof payload.instructions !== "string") {
            throw new Error("Expected complete model instructions");
          }
          const visible = `${payload.instructions}\n${JSON.stringify(payload.input)}`;
          expect(visible).toContain(persistent);
          if (text) {
            // JSON escapes newlines, so assert the full unchanged UTF-8 suffix separately.
            expect(visible).toContain(tail);
            expect(visible).toContain(text.split("\n")[0]);
          } else {
            expect(payload.instructions).not.toContain(tail);
            if (relay) {
              expect(visible).toContain("No additional conversation instructions for this turn.");
            }
          }
          if (relay) {
            expect(visible).toContain("Current OpenClaw tool bindings for this turn");
          }
        }
      }
    } finally {
      release();
      harness.close();
    }
  },
);

it("retains a protected parent through real inbound composition, independent completion, and owner reentry", async () => {
  const { composition, completion } = await prepareConversationTurnContextContract();
  expect(composition.extraSystemPrompt).not.toBe(completion.extraSystemPrompt);
  const agentDir = path.join(tempDir, "producer-agent");
  const codexHome = resolveCodexAppServerHomeDir(agentDir);
  const rolloutPath = path.join(codexHome, "sessions", "producer-parent.jsonl");
  const harness = createStartedThreadHarness(
    async (method, request) =>
      method === "account/read"
        ? { account: { type: "apiKey" } }
        : await persistStartedThreadCatalog(method, request, rolloutPath),
    { persistedThreads: [], codexHome },
  );
  ownCodexInferenceClient(harness.client);
  const ownershipTransfers = vi.spyOn(clientRuntime, "consumeCodexAppServerLiveThread");
  let release = () => {};
  const sessionFile = path.join(tempDir, "producer-parent.jsonl");
  const bindings = [];
  try {
    // Unchanged protected reentry is the control before the independent completion.
    for (const [index, context] of [composition, composition, completion, composition].entries()) {
      const params = createParams(sessionFile, tempDir, { runId: `producer-${index}` });
      params.agentDir = agentDir;
      params.timeoutMs = 60_000;
      params.extraSystemPrompt = context.extraSystemPrompt;
      params.extraSystemPromptTurnContext = context.extraSystemPromptTurnContext;
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      if (index === 0) {
        release = protectCodexAppServerLiveThread(harness.client, "thread-1");
      }
      bindings.push(await readCodexAppServerBinding(sessionFile));
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    }
    expect(bindings[0]?.threadId).toBe("thread-1");
    // Creation settings belong to the live ownership handle, not the persisted binding.
    // Observe real transfers without replacing their authority or return values.
    const ownerships = await Promise.all(ownershipTransfers.mock.results.map(({ value }) => value));
    expect(ownerships).toHaveLength(3);
    for (const ownership of ownerships) {
      expect(ownership?.configFingerprint).toEqual(expect.stringMatching(/\S+/));
      expect(ownership?.configFingerprint).toBe(ownerships[0]?.configFingerprint);
    }
    expect(bindings[0]?.dynamicToolsFingerprint).toEqual(expect.stringMatching(/\S+/));
    for (const binding of bindings.slice(1)) {
      expect(binding?.threadId).toBe(bindings[0]?.threadId);

      expect(binding?.dynamicToolsFingerprint).toBe(bindings[0]?.dynamicToolsFingerprint);
    }
    expect(
      harness.requests
        .filter(({ method }) => ["thread/start", "thread/resume"].includes(method))
        .map(({ method }) => method),
    ).toEqual(["thread/start"]);
    expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(4);
    const changed = createParams(sessionFile, tempDir, { runId: "policy-change" });
    changed.agentDir = agentDir;
    changed.extraSystemPrompt = "Changed persistent operator policy.";
    await expect(runCodexAppServerAttempt(changed)).rejects.toThrow(/claimed by active work/);
  } finally {
    release();
    harness.close();
  }
});

it("continues after bounded plan restoration fails", async () => {
  let rejectedPlan: unknown;
  const harness = createStartedThreadHarness(async (method, params) => {
    if (method === "thread/inject_items" && !isCodexTurnContextHandoff(params)) {
      rejectedPlan = params;
      throw new Error("injected test failure");
    }
    return undefined;
  });
  const run = runCodexAppServerAttempt(createTestParams());
  await run.waitForTurnAccepted();
  await harness.notify({
    method: "turn/plan/updated",
    params: {
      threadId: "thread-1",
      explanation: "e".repeat(10_000),
      plan: Array.from({ length: 100 }, (_, index) => ({
        step: `${index}: ${"x".repeat(2_000)}`,
        status: index === 0 ? "inProgress" : "pending",
      })),
      turnId: "turn-1",
    },
  });
  for (const phase of ["started", "completed"] as const) {
    await harness.notify(
      itemNotification(`item/${phase}`, { type: "contextCompaction", id: "compact-1" }),
    );
  }

  const text = (
    rejectedPlan as { items?: Array<{ content?: Array<{ text?: string }> }> } | undefined
  )?.items?.[0]?.content?.[0]?.text;
  expect(text).toBeDefined();
  const payloadText = text?.slice((text?.indexOf("\n") ?? -1) + 1) ?? "";
  const payload = JSON.parse(payloadText) as {
    markdown?: string;
    plan: Array<{ step: string; status: string }>;
  };
  expect(Buffer.byteLength(payloadText, "utf8")).toBeLessThanOrEqual(32 * 1024);
  expect(Buffer.byteLength(payload.markdown ?? "", "utf8")).toBeLessThanOrEqual(2 * 1024);
  expect(payload.plan.length).toBeLessThanOrEqual(50);
  expect(payload.plan.every((step) => Buffer.byteLength(step.step, "utf8") <= 512)).toBe(true);
  expect(payload.plan[0]?.status).toBe("in_progress");

  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  const result = await run;
  expect(readAttemptTerminal(result).promptError).toBeNull();
});
