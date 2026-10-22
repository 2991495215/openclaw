/* @vitest-environment jsdom */
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import { beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { CronJob } from "../../../api/types.ts";
import {
  ciAutomationJobSpec,
  type CiAutomationOption,
} from "../../../lib/session-pr-automation-spec.ts";
import {
  createHello as hello,
  createGatewayHarness,
  flushSync,
} from "../../../lib/session-pull-requests.test-support.ts";
import * as toast from "../../../lib/toast.ts";
import type { ChatCiAutomationElement } from "./chat-ci-automation-control.tsx";
import "./chat-ci-automation-control.tsx";

const sessionKey = "agent:main:dashboard:ci-test";
const cronStatus = { enabled: true, triggersEnabled: true, jobs: 0 };
const pr = {
  owner: "example",
  repo: "project",
  number: 42,
  branch: "feature",
  title: "CI controls",
  state: "open" as const,
  url: "https://github.com/example/project/pull/42",
};
function inventory(jobs: CronJob[]) {
  return {
    jobs,
    total: jobs.length,
    limit: 200,
    offset: 0,
    hasMore: false,
    nextOffset: null,
    snapshotRevision: "inventory",
  };
}
function job(sessionId: string, option: CiAutomationOption = "autoFix"): CronJob {
  return {
    ...ciAutomationJobSpec({ ...pr, agentId: "main", sessionKey, sessionId }, option),
    id: option + "-" + sessionId,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
    configRevision: "v1",
  };
}

type WriteReply = Promise<unknown> | ((params: unknown) => Promise<unknown>);
class Fixture {
  readonly harness = createGatewayHarness();
  readonly client = new GatewayBrowserClient({ url: "ws://example.test" });
  readonly root = document.createElement("details");
  readonly element: ChatCiAutomationElement;
  jobs: CronJob[] = [];
  read?: Promise<ReturnType<typeof inventory>>;
  writes: Partial<Record<"cron.add" | "cron.update", WriteReply>> = {};
  readonly request = vi.spyOn(this.client, "request").mockImplementation(async (method, params) => {
    if (method === "cron.status") {
      return { ...cronStatus, jobs: this.jobs.length };
    }
    const write =
      method === "cron.add" || method === "cron.update" ? this.writes[method] : undefined;
    return typeof write === "function"
      ? write(params)
      : (write ?? this.read ?? inventory(this.jobs));
  });

  constructor() {
    this.snapshot({ client: this.client, hello: hello(["operator.admin"]) });
    this.root.className = "chat-pr__checks";
    document.body.append(this.root);
    onTestFinished(() => {
      this.root.replaceChildren();
      this.root.remove();
      vi.restoreAllMocks();
    });
    this.root.append(document.createElement("openclaw-chat-ci-automation"));
    this.element = this.root.querySelector<ChatCiAutomationElement>("openclaw-chat-ci-automation")!;
    Object.assign(this.element, { pullRequest: pr, gateway: this.harness.gateway, sessionKey });
  }
  async paint(sessionId: string) {
    this.element.sessionId = sessionId;
    await this.element.updateComplete;
  }
  async open(settled = true) {
    if (!this.root.open) {
      const toggled = new Promise<void>((resolve) => {
        this.root.addEventListener("toggle", () => resolve(), { once: true });
      });
      this.root.open = true;
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(0);
      }
      await toggled;
    }
    await this.element.updateComplete;
    if (settled) {
      await this.settle();
    }
  }
  async settle() {
    await flushSync();
    await this.element.updateComplete;
    await flushSync();
    await this.element.updateComplete;
  }
  checkbox(option: CiAutomationOption = "autoFix") {
    return this.root.querySelector<HTMLInputElement>(`input[name="${option}"]`)!;
  }
  calls(method: string) {
    return this.request.mock.calls.filter(([name]) => name === method);
  }
  snapshot(patch: Partial<Fixture["harness"]["gateway"]["snapshot"]>) {
    this.harness.setSnapshot({ ...this.harness.gateway.snapshot, ...patch });
  }
  toggles(fix: boolean, merge: boolean) {
    expect([this.checkbox().checked, this.checkbox("autoMerge").checked]).toEqual([fix, merge]);
  }
}
describe("CI automation popup scope", () => {
  let h: Fixture;
  let notify: MockInstance<typeof toast.showToast>;
  beforeEach(async () => {
    notify = vi.spyOn(toast, "showToast").mockReturnValue(true);
    h = new Fixture();
    await h.paint("first");
  });
  it("recovers failed inventory reads with backoff and stops polling after success", async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    let unavailable = true;
    h.request.mockImplementation(async (method) => {
      if (method === "cron.status") {
        return cronStatus;
      }
      if (unavailable) {
        if (h.calls("cron.list").length === 1) {
          throw new GatewayProtocolRequestError({
            code: "UNAVAILABLE",
            message: "Temporary inventory failure",
            retryable: true,
            details: { method: "cron.list" },
          });
        }
        throw new GatewayProtocolRequestTimeoutError({
          method: "cron.list",
          timeoutMs: 30_000,
          requestSent: true,
        });
      }
      return inventory(h.jobs);
    });
    await h.open();
    expect(h.calls("cron.list")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.calls("cron.list")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls("cron.list")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.calls("cron.list")).toHaveLength(2);
    unavailable = false;
    h.jobs = [job("first")];
    await vi.advanceTimersByTimeAsync(1);
    await h.settle();
    expect(h.calls("cron.list")).toHaveLength(3);
    expect(h.checkbox().checked).toBe(true);
    expect(h.checkbox().closest("fieldset")?.disabled).toBe(false);
    expect(h.root.textContent).not.toContain("Temporary inventory failure");
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.calls("cron.list")).toHaveLength(3);
  });

  it.each(["hidden", "closed"] as const)(
    "preserves the server retry deadline across %s, reopening, and owner events",
    async (boundary) => {
      vi.useFakeTimers();
      onTestFinished(() => void vi.useRealTimers());
      h.request.mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "Inventory busy",
          retryable: true,
          retryAfterMs: 90_000,
          details: { method: "cron.list" },
        }),
      );
      await h.open();
      expect(h.calls("cron.list")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      if (boundary === "hidden") {
        h.element.presented = false;
      } else {
        h.root.open = false;
      }
      await h.settle();
      await vi.advanceTimersByTimeAsync(10_000);
      if (boundary === "hidden") {
        h.element.presented = true;
      } else {
        await h.open();
      }
      await h.settle();
      expect(h.calls("cron.list")).toHaveLength(1);
      h.harness.emit({}, "cron");
      await h.settle();
      expect(h.calls("cron.list")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(69_999);
      expect(h.calls("cron.list")).toHaveLength(1);
      h.jobs = [job("first")];
      await vi.advanceTimersByTimeAsync(1);
      await h.settle();
      expect(h.calls("cron.list")).toHaveLength(2);
      expect(h.checkbox().checked).toBe(true);
      expect(h.calls("cron.add")).toHaveLength(0);
      expect(h.calls("cron.update")).toHaveLength(0);
    },
  );

  it.each(["hidden", "document hidden", "connection", "session"] as const)(
    "retires scheduled inventory recovery at %s and resumes on return",
    async (boundary) => {
      vi.useFakeTimers();
      onTestFinished(() => void vi.useRealTimers());
      h.request.mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "Temporary inventory failure",
          retryable: true,
          details: { method: "cron.list" },
        }),
      );
      await h.open();
      expect(h.calls("cron.list")).toHaveLength(1);
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      if (boundary === "hidden") {
        h.element.presented = false;
      } else if (boundary === "document hidden") {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (boundary === "connection") {
        h.snapshot({ phase: "offline" });
      } else {
        await h.paint("replacement");
      }
      await h.settle();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(h.calls("cron.list")).toHaveLength(1);
      h.jobs = [job(boundary === "session" ? "replacement" : "first")];
      if (boundary === "hidden") {
        h.element.presented = true;
      } else if (boundary === "document hidden") {
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (boundary === "connection") {
        h.snapshot({ phase: "connected" });
      } else {
        await h.open();
      }
      await vi.advanceTimersByTimeAsync(0);
      await h.settle();
      expect(h.calls("cron.list")).toHaveLength(2);
      expect(h.checkbox().checked).toBe(true);
    },
  );

  it("retires denied inventory without timer retries and waits for fresh owner events", async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    h.jobs = [job("first")];
    await h.open();
    expect(h.checkbox().checked).toBe(true);
    h.request.mockRejectedValueOnce(
      new GatewayProtocolRequestError({
        code: "FORBIDDEN",
        message: "Access revoked",
      }),
    );
    h.harness.emit({}, "cron");
    await h.settle();
    expect(h.calls("cron.list")).toHaveLength(2);
    expect(h.checkbox().checked).toBe(false);
    expect(h.checkbox().closest("fieldset")?.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.calls("cron.list")).toHaveLength(2);
    h.harness.emit({}, "config.changed");
    await h.settle();
    expect(h.calls("cron.list")).toHaveLength(3);
    expect(h.checkbox().checked).toBe(true);
  });

  it("keeps concurrent intents across stale inventory and out-of-order acknowledgements", async () => {
    const staleRead = createDeferred<ReturnType<typeof inventory>>();
    const fixWrite = createDeferred<CronJob>();
    const mergeWrite = createDeferred<{ job: CronJob }>();
    const fix = job("first");
    const merge = job("first", "autoMerge");
    h.jobs = [fix];
    h.writes = { "cron.update": fixWrite.promise, "cron.add": mergeWrite.promise };
    await h.open();
    const before = h.root.textContent;
    h.request.mockImplementationOnce(() => staleRead.promise);
    h.harness.emit({}, "cron");
    await h.element.updateComplete;
    h.checkbox().click();
    expect(h.checkbox().checked).toBe(false);
    await h.element.updateComplete;
    expect(h.checkbox().checked).toBe(false);
    expect(h.checkbox().closest("fieldset")?.disabled).toBe(false);
    expect(h.checkbox("autoMerge").disabled).toBe(false);
    expect(h.root.textContent).toBe(before);
    expect(h.root.querySelector('a[href*="?job="]')).toBeNull();
    h.checkbox("autoMerge").click();
    await h.element.updateComplete;
    h.toggles(false, true);
    expect(h.checkbox("autoArchive").disabled).toBe(false);
    staleRead.resolve(inventory([job("first")]));
    await h.settle();
    h.toggles(false, true);
    h.jobs.push(merge);
    mergeWrite.resolve({ job: merge });
    h.harness.emit({}, "cron");
    h.harness.emit({}, "cron");
    await h.settle();
    expect(h.checkbox().checked).toBe(false);
    expect(h.checkbox().disabled).toBe(true);
    expect(h.checkbox("autoMerge").disabled).toBe(false);
    expect(h.calls("cron.list")).toHaveLength(2);
    const disabledFix = { ...fix, enabled: false, configRevision: "v2" };
    h.jobs = [disabledFix, merge];
    fixWrite.resolve(disabledFix);
    await h.settle();
    expect(h.calls("cron.list")).toHaveLength(3);
    h.toggles(false, true);
    expect(h.checkbox().disabled).toBe(false);
    expect(h.root.textContent).toBe(before);
  });

  it("reports a lost acknowledgement once and reconciles sibling writes without replay", async () => {
    const fixWrite = createDeferred<{ job: CronJob }>();
    const mergeWrite = createDeferred<{ job: CronJob }>();
    h.writes["cron.add"] = (params) =>
      (params as { declarationKey: string }).declarationKey.endsWith(":autoFix")
        ? fixWrite.promise
        : mergeWrite.promise;
    await h.open();
    h.checkbox().click();
    h.checkbox("autoMerge").click();
    fixWrite.reject(new Error("Lost acknowledgement"));
    await h.settle();
    h.toggles(false, true);
    h.jobs = [job("first"), job("first", "autoMerge")];
    h.writes = {};
    mergeWrite.resolve({ job: job("first", "autoMerge") });
    await h.settle();
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      message: "Lost acknowledgement",
      severity: "error",
    });
    expect(h.root.textContent).not.toContain("Lost acknowledgement");
    h.toggles(true, true);
    expect(h.calls("cron.add")).toHaveLength(2);
  });

  it.each(["identity", "connection", "read scope"])(
    "settles a visible popup without %s until its prerequisites change",
    async (missing) => {
      if (missing === "identity") {
        await h.paint("");
      } else if (missing === "connection") {
        h.snapshot({ phase: "reconnecting" });
      } else {
        h.snapshot({ hello: hello(["operator.sessions.read"]) });
      }
      await h.element.updateComplete;
      await h.open(false);
      await h.element.updateComplete;
      expect(await h.element.updateComplete).toBe(true);
      expect(h.request).not.toHaveBeenCalled();
      expect(h.checkbox().closest("fieldset")?.disabled).toBe(true);
    },
  );

  it("ignores a delayed inventory after session replacement", async () => {
    const oldRead = createDeferred<ReturnType<typeof inventory>>();
    h.jobs = [job("first")];
    h.read = oldRead.promise;
    await h.open(false);
    expect(h.request.mock.calls.some(([method]) => method === "cron.list")).toBe(true);
    const signal = h.calls("cron.list")[0]?.[2]?.signal;
    h.element.sessionId = "replacement";
    expect(signal?.aborted).toBe(true);
    expect(h.root.open).toBe(false);
    await h.element.updateComplete;
    h.jobs = [];
    h.read = undefined;
    await h.open();
    oldRead.resolve(inventory([job("first")]));
    await h.settle();
    expect(h.checkbox().checked).toBe(false);
    expect(h.checkbox().closest("fieldset")?.disabled).toBe(false);
    expect(h.root.textContent).not.toContain("fix-first");
  });

  it("retires old inventory before another toggle can target a replacement session", async () => {
    await h.open();
    h.element.sessionId = "replacement";
    // The old DOM is still present until Solid commits the new presentation.
    h.checkbox("autoMerge").click();
    expect(h.calls("cron.add")).toHaveLength(0);
    await h.settle();
    expect(h.root.open).toBe(false);
  });

  it("settles an admitted write while hidden and refreshes when presented again", async () => {
    const pending = createDeferred<{ job: CronJob }>();
    h.writes["cron.add"] = pending.promise;
    await h.open();
    h.checkbox().click();
    h.element.presented = false;
    h.jobs = [job("first")];
    pending.resolve({ job: h.jobs[0]! });
    await h.settle();
    expect(h.calls("cron.add")).toHaveLength(1);
    expect(h.calls("cron.list")).toHaveLength(1);
    expect(h.checkbox().checked).toBe(true);
    expect(h.checkbox().disabled).toBe(false);
    h.element.presented = true;
    await h.settle();
    expect(h.root.open).toBe(true);
    expect(h.calls("cron.list")).toHaveLength(2);
    expect(h.calls("cron.add")).toHaveLength(1);
  });

  it.each(["session", "auth", "gateway"])(
    "ignores a rejected write after %s replacement",
    async (change) => {
      const pending = createDeferred<{ job: CronJob }>();
      h.writes["cron.add"] = pending.promise;
      await h.open();
      h.checkbox().click();
      await h.element.updateComplete;
      if (change === "session") {
        await h.paint("replacement");
        await h.open(false);
      } else if (change === "auth") {
        h.snapshot({ hello: hello(["operator.read"]) });
      } else {
        h.element.gateway = createGatewayHarness().gateway;
      }
      await h.settle();
      pending.reject(new Error("Old context failure"));
      await h.settle();
      expect(h.root.textContent).not.toContain("Old context failure");
      expect(notify).not.toHaveBeenCalled();
      expect(h.checkbox().checked).toBe(false);
      expect(h.calls("cron.add")).toHaveLength(1);
    },
  );

  it("does not apply an old write to a reconnected Gateway or replay it", async () => {
    const pending = createDeferred<CronJob>();
    h.jobs = [job("first")];
    h.writes["cron.update"] = pending.promise;
    await h.open();
    expect(h.checkbox().checked).toBe(true);
    h.checkbox().checked = false;
    h.checkbox().dispatchEvent(new Event("change"));
    await h.element.updateComplete;
    expect(h.calls("cron.update")).toHaveLength(1);
    h.snapshot({ phase: "reconnecting" });
    await h.element.updateComplete;
    h.writes = {};
    h.snapshot({ phase: "connected" });
    await h.settle();
    pending.resolve({ ...job("first"), enabled: false });
    await h.settle();
    expect(h.checkbox().checked).toBe(true);
    expect(h.calls("cron.update")).toHaveLength(1);
  });
});
