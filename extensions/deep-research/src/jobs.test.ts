import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createCapturedPluginRegistration,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchJobs, type ResearchJob } from "./jobs.js";
import { createResearchTool } from "./tool.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "research-jobs-test-"));
  const runtime = createPluginRuntimeMock();
  let jobsNamespace: string | undefined;
  runtime.state.openKeyedStoreV2 = (options, authority = { assertCurrent() {} }) => {
    if (options.namespace.startsWith("research-jobs-v1-")) {
      jobsNamespace = options.namespace;
    }
    return createPluginStateKeyedStoreV2ForTests(
      "deep-research",
      { ...options, env: { OPENCLAW_STATE_DIR: directory } },
      authority,
    );
  };
  const readStore = () => {
    if (!jobsNamespace) {
      throw new Error("No job store was opened by the feature");
    }
    return runtime.state.openKeyedStoreV2<ResearchJob>({
      namespace: jobsNamespace,
      maxEntries: 32,
      overflowPolicy: "reject-new",
    });
  };
  const api = { ...createCapturedPluginRegistration({ id: "deep-research" }).api, runtime };
  const scheduler = createTestPluginServiceScheduler();
  const jobs = new ResearchJobs(api, scheduler);
  const current = vi.fn();
  const context = {
    sessionKey: "agent:main:research-fixture",
    sessionId: "generation-1",
    agentId: "main",
    assertInvocationCurrent: current,
  };
  const tool = createResearchTool(api, context, jobs);
  cleanup.push(async () => {
    await scheduler.stop();
    resetPluginStateStoreForTests();
    await rm(directory, { recursive: true, force: true });
  });
  return { jobs, api, runtime, scheduler, context, tool, current, readStore };
}
const descriptor = {
  version: 1,
  ok: true,
  value: {
    version: 1,
    kind: "managed-research",
    provider: "google",
    agent: "research-agent",
    authModes: ["api-key"],
    citationEvidence: "provider-attributed",
    storageRequired: true,
    hardBudgets: { model: false, search: false, tokens: false },
    idempotentStart: false,
  },
};
const handle = { interactionId: "remote-research-fixture", profileId: "google:research-fixture" };
const completed = {
  version: 1,
  ok: true,
  value: {
    state: "completed",
    handle,
    report: "A provider report.",
    citations: [{ url: "https://example.org/source" }],
    usageTokens: 100,
  },
};
const start = {
  action: "start",
  idempotencyKey: "stable-request",
  request: { question: "Research the river.", engine: "google" },
};

describe("durable research tool", () => {
  it("persists one managed submission/result and returns it idempotently across restart", async () => {
    const { tool, runtime, api, scheduler, context } = await fixture();
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce(completed);
    const first = await tool.execute("call-1", start);
    expect(first.details).toMatchObject({
      state: "completed",
      result: {
        engine: "managed",
        sources: [],
        providerCitations: [{ url: "https://example.org/source" }],
      },
    });
    const reopened = new ResearchJobs(api, scheduler);
    const again = await createResearchTool(api, context, reopened).execute("call-2", {
      ...start,
      request: { engine: "google", question: "Research the river." },
    });
    expect(again.details).toEqual(first.details);
    expect(request).toHaveBeenCalledTimes(2);
    await expect(
      tool.execute("call-3", {
        ...start,
        request: { ...start.request, question: "A different question" },
      }),
    ).rejects.toThrow("Idempotency key");
  });
  it("does not resubmit an ambiguous start and rejects unsupported native constraints before effects", async () => {
    const { tool, runtime } = await fixture();
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce({
        version: 1,
        ok: false,
        state: "indeterminate",
        reason: "Response lost after submission.",
      });
    expect((await tool.execute("call-1", start)).details).toMatchObject({ state: "indeterminate" });
    await tool.execute("call-2", start);
    expect(request).toHaveBeenCalledTimes(2);
    await expect(
      tool.execute("call-3", {
        ...start,
        idempotencyKey: "unsupported",
        request: { ...start.request, budget: { searches: 2 } },
      }),
    ).rejects.toThrow("hard call/token budgets");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("checks conversation generation and live authority before publishing a provider response", async () => {
    const { tool, runtime, current, jobs, context, readStore } = await fixture();
    vi.mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockImplementationOnce(async () => {
        current.mockImplementation(() => {
          throw new Error("retired");
        });
        return completed;
      });
    await expect(tool.execute("call-1", start)).rejects.toThrow("retired");
    current.mockReset();
    const store = readStore();
    const [entry] = await store.entries();
    assert.ok(entry);
    expect(entry.value.result).toBeUndefined();
    await expect(jobs.get(entry.key, { ...context, sessionId: "generation-2" })).rejects.toThrow(
      "conversation generation",
    );
    expect((await jobs.get(entry.key, context)).state).toBe("indeterminate");
  });
  it("reconciles a persisted handle on resume and distinguishes a pending cancellation", async () => {
    const { jobs, runtime, context, readStore } = await fixture();
    await expect(jobs.get("seed", context)).rejects.toThrow("not found");
    const store = readStore();
    const job: ResearchJob = {
      version: 1,
      id: "retained-job",
      request: { question: "River", engine: "google" },
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      agentId: context.agentId,
      createdAt: 0,
      deadlineAt: 0,
      state: "running",
      progress: "Provider running",
      handle,
    };
    await store.register(job.id, job);
    const recovered = await jobs.get(job.id, context);
    expect(recovered.state).toBe("paused");
    const request = vi.mocked(runtime.gateway.request).mockResolvedValueOnce({
      version: 1,
      ok: true,
      value: { state: "running", handle, citations: [] },
    });
    const cancelled = await jobs.cancel(recovered, context);
    expect(cancelled.state).toBe("paused");
    expect(cancelled.progress).toContain("not confirmed");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ request: { action: "cancel", handle } });
    request.mockResolvedValueOnce({
      version: 1,
      ok: true,
      value: { state: "cancelled", handle, citations: [] },
    });
    expect((await jobs.run(cancelled, context)).state).toBe("cancelled");
  });
});

describe("research recovery fault injection", () => {
  it("coalesces overlapping starts and ignores a stale resume snapshot after completion", async () => {
    const { jobs, tool, runtime, context } = await fixture();
    const entered = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<typeof completed>();
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockImplementationOnce(() => {
        entered.resolve();
        return receipt.promise;
      });
    const first = tool.execute("call-1", start);
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error("Operation ended before submission");
      }),
    ]);
    const duplicate = await jobs.start(
      { question: "Research the river.", engine: "google" },
      "stable-request",
      context,
    );
    expect(duplicate.state).toBe("submitting");
    receipt.resolve(completed);
    await first;
    const staleResume = await jobs.run(duplicate, context);
    expect(staleResume.state).toBe("completed");
    expect(request).toHaveBeenCalledTimes(2);
    const result = await tool.execute("read-again", { action: "result", jobId: staleResume.id });
    expect(result.details).toMatchObject({ result: { report: "A provider report." } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves cancellation intent when the provider cannot confirm remote termination", async () => {
    const { jobs, tool, runtime, context } = await fixture();
    const entered = Promise.withResolvers<void>();
    const polling = Promise.withResolvers<unknown>();
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce({
        version: 1,
        ok: true,
        value: { state: "running", handle, citations: [] },
      })
      .mockImplementationOnce(() => {
        entered.resolve();
        return polling.promise;
      });
    const running = tool.execute("call-1", start);
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Operation ended before polling");
      }),
    ]);
    const existing = await jobs.start(
      { question: "Research the river.", engine: "google" },
      "stable-request",
      context,
    );
    await tool.execute("cancel", { action: "cancel", jobId: existing.id });
    request
      .mockResolvedValueOnce({
        version: 1,
        ok: false,
        state: "blocked",
        reason: "Remote cancellation unsupported.",
      })
      .mockResolvedValueOnce(completed);
    polling.resolve({
      version: 1,
      ok: true,
      value: { state: "running", handle, citations: [] },
    });
    expect((await running).details).toMatchObject({ state: "completed" });
    expect(request.mock.calls.at(-2)?.[1]).toMatchObject({ request: { action: "cancel", handle } });
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ request: { action: "poll", handle } });
    const resumed = await tool.execute("resume", { action: "resume", jobId: existing.id });
    expect(resumed.details).toMatchObject({ state: "completed" });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("cancels during discovery without submitting paid research", async () => {
    const { jobs, tool, runtime, context } = await fixture();
    const entered = Promise.withResolvers<void>();
    const discovery = Promise.withResolvers<typeof descriptor>();
    const request = vi.mocked(runtime.gateway.request).mockImplementationOnce(() => {
      entered.resolve();
      return discovery.promise;
    });
    const running = tool.execute("start", start);
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Operation ended before discovery");
      }),
    ]);
    const existing = await jobs.start(
      { question: "Research the river.", engine: "google" },
      "stable-request",
      context,
    );
    await tool.execute("cancel", { action: "cancel", jobId: existing.id });
    discovery.resolve(descriptor);
    expect((await running).details).toMatchObject({ state: "cancelled" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps an in-flight start receipt when cancellation arrives and cancels that handle", async () => {
    const { jobs, tool, runtime, context } = await fixture();
    const entered = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<unknown>();
    let submissionSignal: AbortSignal | undefined;
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockImplementationOnce((_method, _params, options) => {
        submissionSignal = options?.signal;
        entered.resolve();
        return receipt.promise;
      })
      .mockResolvedValueOnce({
        version: 1,
        ok: true,
        value: { state: "cancelled", handle, citations: [] },
      });
    const running = tool.execute("start", start);
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Operation ended before submission");
      }),
    ]);
    const existing = await jobs.start(
      { question: "Research the river.", engine: "google" },
      "stable-request",
      context,
    );
    await tool.execute("cancel", { action: "cancel", jobId: existing.id });
    expect(submissionSignal?.aborted).toBe(false);
    receipt.resolve({ version: 1, ok: true, value: { state: "running", handle, citations: [] } });
    expect((await running).details).toMatchObject({ state: "cancelled" });
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ request: { action: "cancel", handle } });
    await tool.execute("retry", start);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retains idempotency receipts without sharing one conversation's quota with others", async () => {
    const { jobs, runtime, context, readStore } = await fixture();
    vi.mocked(runtime.gateway.request).mockImplementation(async (_method, params) => {
      return (params as { request: { action: string } }).request.action === "describe"
        ? descriptor
        : completed;
    });
    const first = await jobs.start({ question: "River", engine: "google" }, "one", context);
    const store = readStore();
    for (let index = 1; index < 32; index++) {
      await store.register(`retained-${index}`, { ...first, id: `retained-${index}` });
    }
    await expect(
      jobs.start({ question: "River", engine: "google" }, "overflow", context),
    ).rejects.toThrow();
    const other = await jobs.start({ question: "River", engine: "google" }, "one", {
      ...context,
      sessionKey: "agent:main:another-research-fixture",
      sessionId: "generation-2",
    });
    expect(other.state).toBe("completed");
    expect(other.id).not.toBe(first.id);
    expect((await jobs.start({ question: "River", engine: "google" }, "one", context)).id).toBe(
      first.id,
    );
    expect(runtime.gateway.request).toHaveBeenCalledTimes(4);
  });

  it.each(["conversation-retired", "service-reloaded"] as const)(
    "fences a late poll result after %s and never repeats the submission",
    async (reason) => {
      const { tool, runtime, api, scheduler, context, current, readStore } = await fixture();
      const entered = Promise.withResolvers<void>();
      const late = Promise.withResolvers<typeof completed>();
      const request = vi
        .mocked(runtime.gateway.request)
        .mockResolvedValueOnce(descriptor)
        .mockResolvedValueOnce({
          version: 1,
          ok: true,
          value: { state: "running", handle, citations: [] },
        })
        .mockImplementationOnce(() => {
          entered.resolve();
          return late.promise;
        });
      const running = tool.execute("start", start);
      await Promise.race([
        entered.promise,
        running.then(() => {
          throw new Error("No poll was admitted");
        }),
      ]);
      const rejected = expect(running).rejects.toThrow();
      if (reason === "service-reloaded") {
        await scheduler.stop();
      } else {
        // The host retires this capability on reset/deletion; the feature must
        // consume that live decision even when an already-admitted poll returns.
        current.mockImplementation(() => {
          throw new Error("conversation retired");
        });
      }
      late.resolve(completed);
      await rejected;
      const [entry] = await readStore().entries();
      assert.ok(entry);
      expect(entry.value.handle).toEqual(handle);
      expect(entry.value.result).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(3);
      const nextScheduler = createTestPluginServiceScheduler();
      cleanup.push(() => nextScheduler.stop());
      const reopened = new ResearchJobs(api, nextScheduler);
      if (reason === "conversation-retired") {
        await expect(reopened.get(entry.key, context)).rejects.toThrow("conversation retired");
        await expect(
          reopened.get(entry.key, {
            ...context,
            sessionId: "generation-2",
            assertInvocationCurrent() {},
          }),
        ).rejects.toThrow("conversation generation");
        expect(request).toHaveBeenCalledTimes(3);
      } else {
        request.mockResolvedValueOnce(completed);
        const resumed = await reopened.run(await reopened.get(entry.key, context), context);
        expect(resumed.state).toBe("completed");
        expect(request).toHaveBeenCalledTimes(4);
        expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
          request: { action: "poll", handle },
        });
      }
    },
  );
  it("does not repeat a paid portable operation interrupted before its receipt was saved", async () => {
    const { jobs, api, runtime, scheduler, context, readStore } = await fixture();
    const entered = Promise.withResolvers<void>();
    const pendingResponse =
      Promise.withResolvers<Awaited<ReturnType<typeof runtime.llm.complete>>>();
    const modelResponse = (text: string) => ({
      text,
      provider: "example",
      model: "research-model",
      agentId: "main",
      usage: { totalTokens: 10 },
      execution: {
        mode: "direct-provider" as const,
        owner: { kind: "provider" as const, id: "example" },
      },
      audit: { caller: { kind: "plugin" as const, id: "deep-research" } },
    });
    const complete = vi
      .mocked(runtime.llm.complete)
      .mockResolvedValueOnce(modelResponse('{"questions":["River"]}'))
      .mockImplementationOnce(() => {
        entered.resolve();
        return pendingResponse.promise;
      });
    const running = jobs.start(
      {
        question: "River",
        sources: {
          documents: [{ title: "River", text: "The measured river length is twelve kilometers." }],
        },
      },
      "portable-crash",
      context,
    );
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Operation ended before paid completion");
      }),
    ]);
    const rejected = expect(running).rejects.toThrow();
    await scheduler.stop();
    pendingResponse.resolve(modelResponse('{"findings":[],"gaps":[],"queries":[]}'));
    await rejected;
    const nextScheduler = createTestPluginServiceScheduler();
    cleanup.push(() => nextScheduler.stop());
    const reopened = new ResearchJobs(api, nextScheduler);
    const store = readStore();
    const [entry] = await store.entries();
    assert.ok(entry);
    const resumed = await reopened.run(await reopened.get(entry.key, context), context);
    expect(resumed.state).toBe("indeterminate");
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("retains an admitted create receipt after parent abort while host authority is current", async () => {
    const { jobs, api, runtime, scheduler, context, readStore } = await fixture();
    const parent = new AbortController();
    const admitted = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<unknown>();
    let startSignal: AbortSignal | undefined;
    const request = vi
      .mocked(runtime.gateway.request)
      .mockImplementation(async (_method, params, options) => {
        const action = (params?.request as { action?: string }).action;
        if (action === "describe") return descriptor;
        if (action === "start") {
          startSignal = options?.signal;
          admitted.resolve();
          return receipt.promise;
        }
        return completed;
      });
    const running = jobs.start(
      { question: "River", engine: "google" },
      "parent-abort",
      context,
      parent.signal,
    );
    await admitted.promise;
    const rejected = expect(running).rejects.toThrow("parent stopped");
    parent.abort(new Error("parent stopped"));
    expect(startSignal?.aborted).toBe(false);
    receipt.resolve({ version: 1, ok: true, value: { state: "running", handle, citations: [] } });
    await rejected;
    const [entry] = await readStore().entries();
    assert.ok(entry);
    expect(entry.value).toMatchObject({ state: "paused", handle });
    const reopened = new ResearchJobs(api, scheduler);
    const resumed = await reopened.run(await reopened.get(entry.key, context), context);
    expect(resumed.state).toBe("completed");
    expect(
      request.mock.calls.filter(
        ([, params]) => (params?.request as { action?: string }).action === "start",
      ),
    ).toHaveLength(1);
  });

  it("reconciles a known receipt after transient authority refresh without another start", async () => {
    const { jobs, runtime, context } = await fixture();
    const request = vi
      .mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce({
        version: 1,
        ok: false,
        state: "indeterminate",
        handle,
        reason: "Session access is refreshing",
      })
      .mockResolvedValueOnce(completed);
    const job = await jobs.start(
      { question: "River", engine: "google" },
      "refresh-receipt",
      context,
    );
    expect(job).toMatchObject({ state: "paused", handle });
    expect((await jobs.run(job, context)).state).toBe("completed");
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ request: { action: "poll", handle } });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("allows an explicit fresh resume after a known pre-submission rejection", async () => {
    const { jobs, runtime, context } = await fixture();
    vi.mocked(runtime.gateway.request)
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce({
        version: 1,
        ok: false,
        state: "blocked",
        reason: "Request was not sent",
      })
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce(completed);
    const job = await jobs.start(
      { question: "River", engine: "google" },
      "blocked-before-start",
      context,
    );
    expect(job.state).toBe("paused");
    expect((await jobs.run(job, context)).state).toBe("completed");
  });

  it("replays retained portable evidence after the deadline without new paid calls", async () => {
    const { jobs, api, runtime, scheduler, context, readStore } = await fixture();
    const quote = "The measured river length is twelve kilometers.";
    const modelResponse = (value: unknown) => ({
      text: JSON.stringify(value),
      provider: "example",
      model: "research-model",
      agentId: "main",
      usage: { totalTokens: 10 },
      execution: {
        mode: "direct-provider" as const,
        owner: { kind: "provider" as const, id: "example" },
      },
      audit: { caller: { kind: "plugin" as const, id: "deep-research" } },
    });
    const complete = vi
      .mocked(runtime.llm.complete)
      .mockResolvedValueOnce(modelResponse({ questions: ["River"] }))
      .mockResolvedValueOnce(
        modelResponse({
          findings: [
            {
              statement: "The river is twelve kilometers long.",
              evidence: [{ sourceId: "S1", quote }],
            },
          ],
          gaps: [],
          queries: [],
        }),
      )
      .mockResolvedValueOnce(
        modelResponse({
          verdicts: [{ index: 0, verdict: "supported", reason: "Exact measurement" }],
          unanswered: [],
        }),
      );
    const first = await jobs.start(
      { question: "River", sources: { documents: [{ title: "River report", text: quote }] } },
      "expired-portable",
      context,
    );
    expect(first.state).toBe("completed");
    const { result: _result, ...retained } = first;
    await readStore().register(first.id, {
      ...retained,
      state: "running",
      deadlineAt: scheduler.now() - 1,
    });
    const reopened = new ResearchJobs(api, scheduler);
    const resumed = await reopened.run(await reopened.get(first.id, context), context);
    expect(resumed.state).toBe("partial");
    expect(resumed.result?.findings).toEqual(first.result?.findings);
    expect(resumed.result?.report).toContain("The river is twelve kilometers long.");
    expect(resumed.result?.gaps).toContain(
      "Global research deadline exhausted; only recorded evidence was replayed, with no new calls.",
    );
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("starts a queued portable budget on admission and returns a report even with no old receipts", async () => {
    const { jobs, runtime, scheduler, context, readStore } = await fixture();
    await expect(jobs.get("seed", context)).rejects.toThrow("not found");
    const queued: ResearchJob = {
      version: 1,
      id: "queued-portable",
      request: { question: "River", sources: { web: false } },
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      agentId: context.agentId,
      createdAt: scheduler.now() - 1_000_000,
      deadlineAt: 0,
      state: "queued",
      progress: "Queued",
    };
    await readStore().register(queued.id, queued);
    vi.mocked(runtime.llm.complete).mockResolvedValue({
      text: '{"questions":["River"]}',
      provider: "example",
      model: "research-model",
      agentId: "main",
      usage: { totalTokens: 10 },
      execution: { mode: "direct-provider", owner: { kind: "provider", id: "example" } },
      audit: { caller: { kind: "plugin", id: "deep-research" } },
    });
    const admitted = await jobs.run(queued, context);
    expect(admitted.deadlineAt).toBeGreaterThan(queued.createdAt + 180_000);
    expect(runtime.llm.complete).toHaveBeenCalledTimes(1);
    const expired = { ...queued, id: "expired-empty", deadlineAt: scheduler.now() - 1 };
    await readStore().register(expired.id, expired);
    const result = await jobs.run(expired, context);
    expect(result.result?.report).toContain("Global research deadline exhausted");
    expect(runtime.llm.complete).toHaveBeenCalledTimes(1);
  });
});
