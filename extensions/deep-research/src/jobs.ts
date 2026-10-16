import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginServiceSchedulerV1,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ResearchAdapterSnapshot } from "openclaw/plugin-sdk/research-adapter-contract";
import type { ResearchRequest, ResearchResult } from "./contract.js";
import { assertManagedRequest, managedClient, managedResult, reconcileManaged } from "./managed.js";

export type ResearchJob = {
  version: 1;
  id: string;
  request: ResearchRequest;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  createdAt: number;
  deadlineAt: number;
  state:
    | "queued"
    | "running"
    | "paused"
    | "submitting"
    | "indeterminate"
    | "completed"
    | "partial"
    | "cancelled"
    | "failed";
  progress: string;
  handle?: ResearchAdapterSnapshot["handle"];
  result?: ResearchResult;
  cancelRequested?: boolean;
};
type Step = { state: "started" } | { state: "done"; value: unknown } | { state: "failed" };
const retentionMs = 7 * 24 * 60 * 60_000;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const terminal = (job: ResearchJob) =>
  ["completed", "partial", "cancelled", "failed", "indeterminate"].includes(job.state);
// Optional properties are omitted at the JSON persistence boundary. Inputs and receipts
// are validated JSON data; the state store deliberately rejects explicit undefined fields.
function retainedJson<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON encoding must omit undefined; structuredClone preserves fields rejected by the state store.
  return JSON.parse(JSON.stringify(value)) as T;
}
export type ResearchMemo = <T>(key: string, work: () => Promise<T>) => Promise<T>;

/** Feature-owned logical jobs. All effects run in a live tool invocation, never a reconstructed actor. */
export class ResearchJobs {
  private readonly active = new Map<string, AbortController>();
  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly scheduler: PluginServiceSchedulerV1,
  ) {}
  private store<T>(
    kind: "jobs" | "steps" | "cancellations",
    context: OpenClawPluginToolContext<2>,
    assertCurrent = context.assertInvocationCurrent,
  ) {
    if (!context.sessionKey || !context.sessionId || !context.agentId) {
      throw new Error("Research requires a current conversation generation.");
    }
    const scope = hash(`${context.agentId}\n${context.sessionKey}\n${context.sessionId}`);
    return this.api.runtime.state.openKeyedStoreV2<T>(
      {
        namespace: `research-${kind}-v1-${scope}`,
        maxEntries: kind === "steps" ? 4_096 : 32,
        overflowPolicy: "reject-new",
      },
      { assertCurrent },
    );
  }
  async get(id: string, context: OpenClawPluginToolContext<2>) {
    const store = this.store<ResearchJob>("jobs", context);
    const job = await store.lookup(id);
    context.assertInvocationCurrent();
    if (
      !job ||
      job.sessionKey !== context.sessionKey ||
      job.sessionId !== context.sessionId ||
      job.agentId !== context.agentId
    ) {
      throw new Error("Research job not found in this conversation generation.");
    }
    if (!this.active.has(id) && ["running", "submitting"].includes(job.state)) {
      job.state = job.state === "submitting" && !job.handle ? "indeterminate" : "paused";
      job.progress =
        "Prior invocation ended; inspect or resume this job without submitting it again.";
      await store.register(id, job, { ttlMs: retentionMs });
    }
    return job;
  }
  async start(
    request: ResearchRequest,
    key: string,
    context: OpenClawPluginToolContext<2>,
    signal?: AbortSignal,
    progress?: (message: string) => void,
  ) {
    context.assertInvocationCurrent();
    if (!context.sessionKey || !context.sessionId || !context.agentId) {
      throw new Error("Research requires a current conversation generation.");
    }
    if (request.engine === "google") {
      assertManagedRequest(request);
    }
    if (Buffer.byteLength(JSON.stringify(request)) > 262_144) {
      throw new Error("Research request exceeds the retained input limit.");
    }
    const id = hash(`${context.agentId}\n${context.sessionKey}\n${context.sessionId}\n${key}`);
    const job: ResearchJob = {
      version: 1,
      id,
      request,
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      agentId: context.agentId,
      createdAt: this.scheduler.now(),
      deadlineAt: this.scheduler.now() + (request.budget?.durationMs ?? 180_000),
      state: "queued",
      progress: "Accepted",
    };
    const store = this.store<ResearchJob>("jobs", context);
    if (!(await store.registerIfAbsent(id, retainedJson(job), { ttlMs: retentionMs }))) {
      const existing = await this.get(id, context);
      if (!isDeepStrictEqual(existing.request, retainedJson(request))) {
        throw new Error("Idempotency key belongs to a different research request.");
      }
      return existing;
    }
    return this.run(job, context, signal, progress);
  }
  async cancel(job: ResearchJob, context: OpenClawPluginToolContext<2>, signal?: AbortSignal) {
    if (terminal(job)) {
      return job;
    }
    await this.store<boolean>("cancellations", context).register(job.id, true, {
      ttlMs: retentionMs,
    });
    context.assertInvocationCurrent();
    const active = this.active.get(job.id);
    if (active) {
      active.abort(new Error("Research cancellation requested"));
      return { ...job, cancelRequested: true };
    }
    return this.run({ ...job, cancelRequested: true }, context, signal);
  }
  private async wait(jobId: string, delayMs: number, signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        timer.cancel();
        resolve();
      };
      const abort = () => {
        signal.removeEventListener("abort", abort);
        timer.cancel();
        reject(signal.reason instanceof Error ? signal.reason : new Error("Research interrupted"));
      };
      const timer = this.scheduler.schedule({
        id: `${jobId}:${randomUUID()}`,
        delayMs,
        run: finish,
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
  }
  async run(
    initialJob: ResearchJob,
    context: OpenClawPluginToolContext<2>,
    parentSignal?: AbortSignal,
    progress: (message: string) => void = () => {},
  ) {
    let job = initialJob;
    if (terminal(job) || this.active.has(job.id)) {
      return job;
    }
    if (this.active.size >= 4) {
      throw new Error(
        "Four research invocations are already active; resume this queued job later.",
      );
    }
    const cancel = new AbortController();
    this.active.set(job.id, cancel);
    const invocationSignal = AbortSignal.any([
      this.scheduler.signal,
      ...(parentSignal ? [parentSignal] : []),
    ]);
    const signal = AbortSignal.any([invocationSignal, cancel.signal]);
    const assertCurrent = () => {
      invocationSignal.throwIfAborted();
      context.assertInvocationCurrent();
    };
    const store = this.store<ResearchJob>("jobs", context, assertCurrent);
    const save = async () => {
      assertCurrent();
      await store.register(job.id, retainedJson(job), { ttlMs: retentionMs });
    };
    let uncertain = false;
    const steps = this.store<Step>("steps", context, assertCurrent);
    const memo: ResearchMemo = async <T>(key: string, work: () => Promise<T>) => {
      assertCurrent();
      signal.throwIfAborted();
      const stepId = `${job.id}:${hash(key)}`;
      const existing = await steps.lookup(stepId);
      assertCurrent();
      signal.throwIfAborted();
      if (existing?.state === "done") {
        return existing.value as T;
      } // This namespace is written only by this operation's typed producer.
      if (existing?.state === "started") {
        uncertain = true;
        throw new Error("Interrupted operation has no recorded receipt; not repeated.");
      }
      if (existing?.state === "failed") {
        throw new Error("A prior operation failed and will not be repeated automatically.");
      }
      await steps.register(stepId, { state: "started" }, { ttlMs: retentionMs });
      assertCurrent();
      signal.throwIfAborted();
      try {
        const value = await work();
        assertCurrent();
        await steps.register(stepId, retainedJson({ state: "done" as const, value }), {
          ttlMs: retentionMs,
        });
        return value;
      } catch (error) {
        assertCurrent();
        if (!signal.aborted) {
          await steps.register(stepId, { state: "failed" }, { ttlMs: retentionMs });
        }
        throw error;
      }
    };
    try {
      assertCurrent();
      // A resume may have read before another invocation finished. Own the active slot,
      // then consume the latest receipt before any submission or paid operation.
      job = await this.get(job.id, context);
      if (terminal(job)) {
        return job;
      }
      job.cancelRequested =
        (await this.store<boolean>("cancellations", context, assertCurrent).lookup(job.id)) ??
        job.cancelRequested ??
        false;
      if (job.request.engine === "google") {
        const client = managedClient(this.api, context);
        if (!job.handle && !job.cancelRequested) {
          const descriptor = await client({ version: 1, action: "describe" }, invocationSignal);
          if (
            !descriptor.ok ||
            !("kind" in descriptor.value) ||
            descriptor.value.kind !== "managed-research"
          ) {
            throw new Error("No explicitly activated managed research adapter is available.");
          }
          job.state = "submitting";
          job.progress = "Submitting managed research";
          await save();
          job.cancelRequested =
            (await this.store<boolean>("cancellations", context, assertCurrent).lookup(job.id)) ??
            job.cancelRequested;
          assertCurrent();
          if (job.cancelRequested || cancel.signal.aborted) {
            job.state = "cancelled";
            job.progress = "Cancelled before submission";
            await save();
            return job;
          }
          // Once admitted, local cancellation waits for the receipt, then requests
          // remote cancellation. Aborting this RPC would discard a recoverable handle.
          const response = await client(
            {
              version: 1,
              action: "start",
              question: job.request.question,
              ...(job.request.output === undefined ? {} : { output: job.request.output }),
              ...(job.request.asOf === undefined ? {} : { asOf: job.request.asOf }),
            },
            invocationSignal,
          );
          if (!response.ok) {
            job.handle = response.handle;
            job.state = response.handle
              ? "paused"
              : response.state === "indeterminate"
                ? "indeterminate"
                : "failed";
            job.progress = response.reason;
            await save();
            return job;
          }
          if (!("state" in response.value)) {
            throw new Error("Adapter returned a descriptor instead of a research receipt.");
          }
          job.handle = response.value.handle;
          await save(); // Record the remote receipt before any poll or wait.
          if (response.value.state !== "running") {
            return await this.finishManaged(job, response.value, save);
          }
        }
        if (!job.handle) {
          job.state = "cancelled";
          job.progress = "Cancelled before submission";
          await save();
          return job;
        }
        const waitUntil =
          this.scheduler.now() + Math.min(job.request.budget?.durationMs ?? 60_000, 60_000);
        let retries = 0;
        while (true) {
          assertCurrent();
          job.cancelRequested =
            (await this.store<boolean>("cancellations", context, assertCurrent).lookup(job.id)) ??
            job.cancelRequested ??
            false;
          const response = await reconcileManaged(
            client,
            job.handle,
            job.cancelRequested,
            invocationSignal,
          );
          if (!response.ok) {
            if (
              !job.cancelRequested &&
              response.retryAfterMs !== undefined &&
              retries++ < 3 &&
              this.scheduler.now() < waitUntil
            ) {
              await this.wait(
                job.id,
                Math.min(response.retryAfterMs, Math.max(0, waitUntil - this.scheduler.now())),
                signal,
              );
              continue;
            }
            job.state = "paused";
            job.progress = response.reason;
            await save();
            return job;
          }
          if (!("state" in response.value)) {
            throw new Error("Expected a research snapshot.");
          }
          if (response.value.state !== "running") {
            return await this.finishManaged(job, response.value, save);
          }
          job.state = "running";
          job.progress = job.cancelRequested
            ? "Provider cancellation is not confirmed; resume to reconcile."
            : "Provider research is running";
          await save();
          progress(job.progress);
          if (job.cancelRequested || this.scheduler.now() >= waitUntil) {
            job.state = "paused";
            await save();
            return job;
          }
          await this.wait(
            job.id,
            Math.min(response.value.retryAfterMs ?? 5_000, waitUntil - this.scheduler.now()),
            signal,
          );
        }
      }
      if (job.cancelRequested) {
        job.state = "cancelled";
        job.progress = "Cancelled";
        await save();
        return job;
      }
      const remaining = job.deadlineAt - this.scheduler.now();
      if (remaining <= 0) {
        job.state = "partial";
        job.progress = "Global research deadline exhausted; no further calls made.";
        await save();
        return job;
      }
      job.state = "running";
      job.progress = "Researching";
      await save();
      const { executePortableResearch } = await import("./portable-tool.js");
      const result = await executePortableResearch(
        this.api,
        context,
        { ...job.request, budget: { ...job.request.budget, durationMs: remaining } },
        signal,
        progress,
        memo,
      );
      assertCurrent();
      job.cancelRequested =
        (await this.store<boolean>("cancellations", context, assertCurrent).lookup(job.id)) ??
        job.cancelRequested ??
        false;
      job.result = job.cancelRequested ? { ...result, status: "cancelled" } : result;
      job.state = uncertain ? "indeterminate" : job.result.status;
      job.progress = uncertain
        ? "Interrupted operation was not repeated; available evidence is partial."
        : "Report ready";
      await save();
      return job;
    } catch (error) {
      assertCurrent();
      if (cancel.signal.aborted && job.request.engine === "google" && job.handle) {
        const response = await reconcileManaged(
          managedClient(this.api, context),
          job.handle,
          true,
          invocationSignal,
        );
        if (response.ok && "state" in response.value && response.value.state !== "running") {
          return await this.finishManaged(job, response.value, save);
        }
        job.state = "paused";
        job.progress =
          "Cancellation requested; provider termination is not confirmed. Resume to reconcile.";
        await save();
        return job;
      }
      job.state =
        job.request.engine === "google"
          ? job.state === "submitting" && !job.handle
            ? "indeterminate"
            : "paused"
          : cancel.signal.aborted
            ? "cancelled"
            : "failed";
      job.progress =
        job.state === "indeterminate"
          ? "Submission outcome is unknown; do not repeat it."
          : "Research interrupted; inspect the retained state before resuming.";
      await save();
      if (cancel.signal.aborted) {
        return job;
      }
      throw error;
    } finally {
      this.active.delete(job.id);
    }
  }
  private async finishManaged(
    job: ResearchJob,
    snapshot: ResearchAdapterSnapshot,
    save: () => Promise<void>,
  ) {
    job.handle = snapshot.handle;
    job.result = managedResult(snapshot);
    job.state =
      snapshot.state === "completed" ||
      snapshot.state === "cancelled" ||
      snapshot.state === "partial"
        ? snapshot.state
        : snapshot.state === "indeterminate"
          ? "indeterminate"
          : "failed";
    job.progress = snapshot.reason ?? "Provider report ready";
    await save();
    return job;
  }
}
