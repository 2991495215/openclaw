/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiSessionPullRequestCheckDetails } from "../../../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../../../app/gateway.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import type { ChatCiDetailsElement } from "./chat-ci-details.tsx";
import { ChatPullRequestChecks } from "./chat-pull-request-checks.tsx";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import {
  paintChatPullRequests,
  clearChatPullRequests,
  publication,
  pullRequest,
  sessionBranch,
} from "./chat-pull-requests.test-support.ts";
import {
  chatBranchId,
  chatPullRequestId,
  dismissChatPullRequest,
  listDismissedChatPullRequests,
} from "./chat-pull-requests.ts";

describe("ChatPullRequests", () => {
  let container: HTMLDivElement;

  function paint(props: Partial<ChatPullRequestsProps>) {
    paintChatPullRequests(
      {
        pullRequests: [],
        status: "ready",
        onDismiss: () => {},
        ...props,
      },
      container,
    );
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    clearChatPullRequests(container);
    container.remove();
  });

  it("keeps native disclosure intent through parking and clears it on dismissal", () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    let update!: (next: { presented: boolean; dismissed: boolean }) => void;
    const mounted = mountSolid(
      () => {
        const [state, setState] = createSignal({ presented: true, dismissed: false });
        update = setState;
        return createComponent(ChatPullRequestChecks, {
          label: "Checks passed",
          checksState: "passing",
          children: "All checks passed",
          get presented() {
            return state().presented;
          },
          get dismissed() {
            return state().dismissed;
          },
        });
      },
      { container },
    );
    try {
      flush();
      const disclosure = container.querySelector<HTMLDetailsElement>("details")!;
      const surface = container.querySelector<HTMLElement>("[popover]")!;
      disclosure.open = true;
      disclosure.dispatchEvent(new Event("toggle"));
      expect(surface.matches(":popover-open")).toBe(true);
      update({ presented: false, dismissed: false });
      flush();
      expect(disclosure.open).toBe(true);
      expect(surface.matches(":popover-open")).toBe(false);
      update({ presented: true, dismissed: false });
      flush();
      expect(surface.matches(":popover-open")).toBe(true);
      expect(container.querySelector("details")).toBe(disclosure);
      update({ presented: false, dismissed: true });
      flush();
      expect(disclosure.open).toBe(false);
      expect(surface.matches(":popover-open")).toBe(false);
      update({ presented: true, dismissed: false });
      flush();
      expect(disclosure.open).toBe(false);
      expect(surface.matches(":popover-open")).toBe(false);
      expect(
        warnings.mock.calls.filter(([text]) => String(text).includes("STRICT_READ_UNTRACKED")),
      ).toEqual([]);
    } finally {
      mounted.unmount();
      warnings.mockRestore();
    }
  });

  it("keeps unknown diff counts absent rather than inventing zeroes", () => {
    paint({ pullRequests: [pullRequest({ additions: undefined, deletions: 0 })] });
    expect(container.querySelector(".chat-pr__additions")).toBeNull();
    expect(container.querySelector(".chat-pr__deletions")?.textContent).toBe("−0");
  });

  it("does not call account discovery Publishing before any publication is admitted", () => {
    paintChatPullRequests(
      {
        pullRequests: [],
        branch: sessionBranch(),
        status: "ready",
        onDismiss: () => {},
        publication: publication({ activity: "read", selection: null }),
      },
      container,
    );
    expect(container.textContent).not.toContain("Publishing");
    expect(container.querySelector<HTMLButtonElement>(".chat-pr__create")?.disabled).toBe(true);
  });

  it.each(["unavailable", "rate-limited"] as const)(
    "keeps the known PR through %s and adopts the next snapshot",
    (status) => {
      const pr = pullRequest({ state: "merged" });
      paint({ pullRequests: [pr] });
      const row = container.querySelector(".chat-pr");
      paint({ pullRequests: [pr], status });
      expect(container.querySelector(".chat-pr")).toBe(row);
      expect(row?.textContent).toContain("openclaw/openclaw#103469");
      expect(row?.querySelector(".chat-pr__additions")?.textContent).toBe("+4");
      expect(container.querySelector(".panel-feedback, .chat-pr__warning")).toBeNull();
      paint({ pullRequests: [{ ...pr, additions: 8 }], status: "ready" });
      expect(container.querySelector(".chat-pr")).toBe(row);
      expect(row?.querySelector(".chat-pr__additions")?.textContent).toBe("+8");
    },
  );

  it("renders merged PRs without a redundant completed publication card", () => {
    const onDismiss = vi.fn();
    const onNewAction = vi.fn();
    paintChatPullRequests(
      {
        pullRequests: [
          pullRequest({
            state: "merged",
            additions: undefined,
            deletions: undefined,
            checks: undefined,
            checksUrl: undefined,
          }),
        ],
        status: "rate-limited",
        onDismiss,
        publication: publication({
          activity: null,
          result: {
            requestId: "publication-merged",
            status: "published",
            url: pullRequest().url,
            repository: "openclaw/openclaw",
            branch: pullRequest().branch,
            headCommit: "a".repeat(40),
            publisher: { source: "agent-override", accountId: 3, login: "agent-bot" },
          },
          onNewAction,
        }),
      },
      container,
    );
    const chip = container.querySelector(".chat-pr");
    expect(chip?.getAttribute("data-state")).toBe("merged");
    expect(chip?.querySelector(".chat-pr__state")?.textContent?.trim()).toBe("Merged");
    expect(chip?.querySelector(".chat-pr__diff")).toBeNull();
    expect(chip?.querySelector(".chat-pr__checks")?.getAttribute("data-checks")).toBe("none");
    expect(chip?.querySelector("openclaw-chat-ci-automation")).not.toBeNull();
    expect(chip?.querySelector("openclaw-chat-ci-details")).toBeNull();
    // Merged is terminal, so the stale-data warning stays off merged chips.
    expect(chip?.querySelector(".chat-pr__warning")).toBeNull();
    expect(container.querySelectorAll(".chat-pr")).toHaveLength(1);
    expect(container.textContent).not.toContain("Choose a new publication");
    expect(container.textContent).not.toContain("Publish as");
    const dismiss = chip?.querySelector<HTMLButtonElement>(".chat-pr__dismiss");
    expect(dismiss?.disabled).toBe(false);
    dismiss?.click();
    expect(onNewAction).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("shows unpublished changes on the same branch instead of merged PR history", () => {
    const branch = pullRequest().branch;
    paintChatPullRequests(
      {
        pullRequests: [pullRequest({ state: "merged" })],
        branch: sessionBranch({ branch }),
        status: "ready",
        onDismiss: () => {},
        publication: publication(),
      },
      container,
    );
    expect(container.querySelectorAll(".chat-pr")).toHaveLength(1);
    expect(container.querySelector(".chat-pr__number")).toBeNull();
    expect(container.querySelector(".chat-pr__branch")?.textContent).toBe(branch);
    expect(container.querySelector(".chat-pr__create")?.textContent).toContain("Publish PR");
  });

  it("does not attach a failed session publication to any PR when live and settled rows reorder", () => {
    const failedPublication = publication({
      result: {
        requestId: "failed-session-attempt",
        status: "failed",
        code: "unavailable",
        message: "GitHub publication failed.",
        nextAction: "Check repository read access before retrying publication.",
        publisher: { source: "agent-override", accountId: 3, login: "agent-bot" },
      },
      onNewAction: vi.fn(),
    });
    const merged = pullRequest({ state: "merged" });
    const unrelated = pullRequest({
      number: 42,
      owner: "synthetic",
      repo: "another-project",
      branch: "feature/unrelated",
      url: "https://github.com/synthetic/another-project/pull/42",
    });
    for (const state of ["open", "merged"] as const) {
      paint({ pullRequests: [merged, { ...unrelated, state }], publication: failedPublication });
      const rows = [...container.querySelectorAll("article.chat-pr")];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.textContent).not.toContain("Check repository read access");
        expect(row.querySelector("[data-publication-account]")).toBeNull();
        expect(row.querySelector(".chat-pr__create")).toBeNull();
      }
      const history = container.querySelector<HTMLDetailsElement>(
        "details.chat-pr__publication-history",
      );
      expect(history?.closest("article")).toBeNull();
      expect(history?.querySelector("summary")?.textContent?.trim()).toBe(
        "Publication attempt failed",
      );
      expect(history?.open).toBe(false);
      expect(history?.textContent).toContain("Check repository read access before retrying");
    }
  });

  it.each(["requested", "publishing", "needs_confirmation"] as const)(
    "keeps %s publication recovery exposed beside merged history",
    (status) => {
      const onRefresh = vi.fn();
      const onConfirm = vi.fn();
      paint({
        pullRequests: [pullRequest({ state: "merged" })],
        publication: publication({
          locked: true,
          result: {
            requestId: "active-publication",
            status,
            message: "The original publication still needs attention.",
            publisher: { source: "personal", accountId: 2, login: "alice-tools" },
          },
          confirmation:
            status === "needs_confirmation"
              ? {
                  requestDigest: "a".repeat(64),
                  generation: "personal-generation",
                  account: { accountId: 2, login: "alice-tools" },
                  repository: "synthetic/publication-demo",
                  pushRepository: "alice-tools/publication-demo",
                  branch: "feature/original",
                  baseBranch: "main",
                  sourceHeadCommit: "1".repeat(40),
                  sourceIndexTree: "2".repeat(40),
                  workspaceTree: "3".repeat(40),
                }
              : null,
          onRefresh,
          onConfirm: status === "needs_confirmation" ? onConfirm : undefined,
        }),
      });
      const outcome = container.querySelector(".chat-pr__publication-outcome");
      expect(outcome?.textContent).toContain("The original publication still needs attention.");
      expect(outcome?.closest("details:not([open])")).toBeNull();
      expect(container.querySelector(".chat-pr__publication-history")).toBeNull();
      const action = container.querySelector<HTMLButtonElement>(".chat-pr__create");
      expect(action?.disabled).toBe(false);
      action?.click();
      expect(status === "needs_confirmation" ? onConfirm : onRefresh).toHaveBeenCalledOnce();
    },
  );

  it("keeps the current PR and CI visible when an older receipt falls out of the PR snapshot", () => {
    const onNewAction = vi.fn();
    const onDismiss = vi.fn();
    paintChatPullRequests(
      {
        pullRequests: [pullRequest()],
        status: "ready",
        onDismiss,
        publication: publication({
          result: {
            requestId: "old-publication",
            status: "published",
            url: "https://github.com/openclaw/openclaw/pull/1",
            repository: "openclaw/openclaw",
            branch: pullRequest().branch,
            headCommit: "a".repeat(40),
          },
          onNewAction,
        }),
      },
      container,
    );
    expect(container.querySelectorAll(".chat-pr")).toHaveLength(1);
    expect(container.querySelector(".chat-pr__number")?.textContent).toBe(
      "openclaw/openclaw#103469",
    );
    expect(container.querySelector(".chat-pr__checks")).not.toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-pr__dismiss")?.click();
    expect(onNewAction).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps publication recovery separate and expanded after publication completed", () => {
    const onRefresh = vi.fn();
    paintChatPullRequests(
      {
        pullRequests: [pullRequest()],
        status: "ready",
        onDismiss: () => {},
        publication: publication({
          locked: false,
          error: "Response lost.",
          onRefresh,
          result: {
            requestId: "published-with-refresh-error",
            status: "published",
            url: pullRequest().url,
            repository: "openclaw/openclaw",
            branch: pullRequest().branch,
            headCommit: "a".repeat(40),
          },
        }),
      },
      container,
    );
    expect(container.querySelectorAll(".chat-pr")).toHaveLength(1);
    expect(container.textContent).toContain("#103469");
    expect(container.textContent).toContain("Response lost.");
    const recovery = container.querySelector(".chat-pr__publication-outcome");
    expect(recovery?.closest("article")).toBeNull();
    expect(recovery?.closest("details:not([open])")).toBeNull();
    expect(container.querySelectorAll(".chat-pr__create")).toHaveLength(0);
    const action = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === "Refresh publication",
    );
    expect(action).toBeDefined();
    action?.click();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(container.querySelectorAll(".chat-pr__dismiss")).toHaveLength(1);
  });

  it("opens the session diff from interactive branch stats", () => {
    const onOpenSessionDiff = vi.fn();
    paint({
      pullRequests: [],
      branch: sessionBranch(),
      onOpenSessionDiff,
    });

    const button = container.querySelector<HTMLButtonElement>("button.chat-pr__diff");
    expect(button?.getAttribute("aria-label")).toBe("Show session changes");
    button?.click();
    expect(onOpenSessionDiff).toHaveBeenCalledOnce();
  });

  it("hides the Create PR link while the branch has no createUrl", () => {
    paint({
      pullRequests: [],
      // Unpushed branch with local changed files: the gateway omits
      // createUrl because GitHub's pull/new page would 404.
      branch: sessionBranch({ createUrl: undefined, additions: 12, deletions: 3 }),
    });
    const row = container.querySelector('.chat-pr[data-state="branch"]');
    expect(row?.querySelector(".chat-pr__branch")?.textContent).toBe(
      "claude/cloud-workers-live-events",
    );
    expect(row?.querySelector(".chat-pr__additions")?.textContent).toBe("+12");
    expect(row?.querySelector(".chat-pr__create")).toBeNull();
  });

  it("shows Gateway publication request and terminal URL states", () => {
    const onPublish = vi.fn();
    const props: ChatPullRequestsProps = {
      pullRequests: [],
      branch: sessionBranch(),
      status: "ready",
      onDismiss: () => {},
      publication: publication({ onPublish }),
    };
    paint(props);
    const publish = container.querySelector<HTMLButtonElement>(".chat-pr__create");
    publish?.click();
    expect(onPublish).toHaveBeenCalledOnce();
    expect(publish?.textContent).toContain("Publish PR");

    paint({
      ...props,
      publication: publication({
        result: {
          requestId: "publication-1",
          status: "published",
          url: "https://github.com/openclaw/openclaw/pull/125200",
          repository: "openclaw/openclaw",
          branch: "openclaw/ui-fix",
          headCommit: "a".repeat(40),
          publisher: { source: "personal", accountId: 2, login: "alice-tools" },
        },
      }),
    });
    expect(container.querySelector<HTMLAnchorElement>(".chat-pr__create")?.href).toBe(
      "https://github.com/openclaw/openclaw/pull/125200",
    );
    expect(container.querySelector(".chat-pr__branch")?.textContent).toBe(props.branch?.branch);
    expect(container.querySelector(".chat-pr__diff")).not.toBeNull();
    expect(container.querySelector(".chat-pr__publication-outcome")).toBeNull();

    paint({
      ...props,
      publication: publication({
        result: {
          requestId: "publication-2",
          status: "failed",
          code: "push_rejected",
          message: "GitHub publication failed.",
          nextAction: "Check repository write access and retry.",
          publisher: { source: "agent-override", accountId: 3, login: "agent-bot" },
        },
        onNewAction: () => {},
      }),
    });
    const failure = container.querySelector('.chat-pr__publication-outcome[data-state="failed"]');
    expect(failure?.textContent).toContain("Publication failed");
    expect(failure?.textContent).toContain("Check repository write access and retry.");
    expect(failure?.closest("details:not([open])")).toBeNull();
    const status = failure?.querySelector<HTMLDetailsElement>(
      "details.chat-pr__publication-status",
    );
    expect(status?.open).toBe(false);
    expect(status?.querySelector("summary")?.textContent?.trim()).toBe("Publication failed");
    expect(failure?.closest("article")?.getAttribute("data-state")).toBe("branch");
    expect(container.querySelector<HTMLButtonElement>(".chat-pr__create")?.textContent).toContain(
      "Choose a new publication",
    );
    expect(container.textContent).toContain("Publish as @agent-bot");
    expect(container.textContent).toContain("Agent override");
    expect(container.querySelector("a.chat-pr__create")).toBeNull();

    paint({
      ...props,
      publication: publication({
        error: "Repository write permission is missing.",
        locked: true,
      }),
    });
    const retry = container.querySelector<HTMLButtonElement>(".chat-pr__create");
    expect(retry?.textContent).toContain("Retry publication");
    expect(container.textContent).toContain("Repository write permission is missing.");
    expect(container.textContent).toContain("The outcome is unknown");
    expect(container.querySelector("a.chat-pr__create")).toBeNull();
  });
});

describe("branch row dismissal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    clearChatPullRequests(container);
    container.remove();
  });

  it("hides the branch row and its idle publish offer once dismissed", () => {
    const onDismissBranch = vi.fn();
    const props = {
      pullRequests: [],
      branch: sessionBranch(),
      status: "ready" as const,
      onDismiss: () => {},
      onDismissBranch,
      publication: publication({
        canPublishPersonal: false,
        options: {
          shared: { source: "system-configured", accountId: 1, login: "system-bot" },
          personal: null,
          pendingPersonal: null,
          latestShared: null,
        },
      }),
    };
    paintChatPullRequests(props, container);
    container.querySelector<HTMLButtonElement>(".chat-pr__dismiss")?.click();
    expect(onDismissBranch).toHaveBeenCalledWith(sessionBranch());

    paintChatPullRequests({ ...props, branchDismissed: true }, container);
    expect(container.querySelector(".chat-pr")).toBeNull();
  });
});

describe("dismissed pull request storage", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops the oldest sessions once the store limit is reached", () => {
    const chip = pullRequest();
    for (let index = 0; index < 21; index += 1) {
      dismissChatPullRequest(`agent:main:${index}`, chatPullRequestId(chip));
    }
    expect(listDismissedChatPullRequests("agent:main:0").size).toBe(0);
    expect(listDismissedChatPullRequests("agent:main:20").size).toBe(1);
  });

  it("keeps branches that differ only in case distinct", () => {
    const ids = dismissChatPullRequest(
      "agent:main:main",
      chatBranchId(sessionBranch({ owner: "OpenClaw", branch: "Feature" })),
    );

    expect(ids.has(chatBranchId(sessionBranch({ owner: "openclaw", branch: "Feature" })))).toBe(
      true,
    );
    expect(ids.has(chatBranchId(sessionBranch({ branch: "feature" })))).toBe(false);
  });

  it("ignores malformed stored payloads", () => {
    localStorage.setItem("openclaw.chat.dismissedPullRequests", "not json");
    expect(listDismissedChatPullRequests("agent:main:main").size).toBe(0);
  });
});

describe("CI job details", () => {
  let container: HTMLDivElement;
  const headSha = "a".repeat(40);
  const details = (
    overrides: Partial<ControlUiSessionPullRequestCheckDetails> = {},
  ): ControlUiSessionPullRequestCheckDetails => ({
    owner: "openclaw",
    repo: "openclaw",
    number: 103469,
    headSha,
    status: "ready",
    rateLimited: false,
    checks: [
      {
        id: 1,
        name: "Build",
        state: "passed",
        status: "completed",
        conclusion: "success",
        source: "actions",
      },
      { id: 2, name: "Tests", state: "running", status: "in_progress", source: "actions" },
      {
        id: 3,
        name: "Lint",
        state: "failed",
        status: "completed",
        conclusion: "failure",
        source: "actions",
        startedAt: "2026-09-14T00:00:00Z",
        completedAt: "2026-09-14T00:01:12Z",
        detailsUrl: "https://github.com/openclaw/openclaw/actions/runs/10/job/30",
        steps: [
          { number: 3, name: "Lint sources", status: "completed", conclusion: "failure" },
          { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
          { number: 4, name: "Upload report", status: "completed", conclusion: "skipped" },
          { number: 2, name: "Install", status: "completed", conclusion: "success" },
        ],
      },
      {
        id: 4,
        name: "Deploy",
        state: "skipped",
        status: "completed",
        conclusion: "skipped",
        source: "actions",
      },
    ],
    ...overrides,
  });

  function harness() {
    const client = new GatewayBrowserClient({ url: "ws://localhost:12345" });
    const request = vi.spyOn(client, "request").mockResolvedValue(details());
    let snapshot: ApplicationGatewaySnapshot = {
      client,
      phase: "connected",
      offlineStable: false,
      hello: null,
      canvasPluginSurfaceUrl: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
      lastError: null,
      lastErrorCode: null,
    };
    const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
    const gateway: ApplicationGateway = {
      get snapshot() {
        return snapshot;
      },
      connection: {
        gatewayUrl: "ws://localhost:12345",
        token: "",
        bootstrapToken: "",
        password: "",
      },
      connectionRevision: 0,
      eventLog: [],
      eventLogRevision: 0,
      loadSelfProfile: async () => null,
      connect() {},
      defer: () => false,
      setSessionKey() {},
      start() {},
      stop() {},
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      subscribeEvents: () => () => {},
      subscribeEventLog: () => () => {},
    };
    const props = {
      pullRequests: [pullRequest({ headSha })],
      gateway,
      sessionKey: "agent:main:main",
      status: "ready" as const,
      onDismiss() {},
    };
    paintChatPullRequests(props, container);
    const element = container.querySelector<ChatCiDetailsElement>("openclaw-chat-ci-details")!;
    const disclosure = container.querySelector<HTMLDetailsElement>(".chat-pr__checks")!;
    return {
      request,
      props,
      element,
      disclosure,
      setPhase(phase: ApplicationGatewaySnapshot["phase"]) {
        snapshot = { ...snapshot, phase };
        for (const listener of listeners) {
          listener(snapshot);
        }
      },
    };
  }

  async function settle(element: ChatCiDetailsElement) {
    await vi.advanceTimersByTimeAsync(0);
    await element.updateComplete;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:02:00Z"));
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    clearChatPullRequests(container);
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fetches only while open, prioritizes live failures, and keeps manual job expansion across refresh", async () => {
    const h = harness();
    await settle(h.element);
    expect(h.request).not.toHaveBeenCalled();
    h.disclosure.open = true;
    await settle(h.element);
    expect(h.request).toHaveBeenCalledWith(
      "controlUi.sessionPullRequests.checks",
      {
        sessionKey: "agent:main:main",
        owner: "openclaw",
        repo: "openclaw",
        number: 103469,
        headSha,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(
      [...container.querySelectorAll(".chat-ci__jobs > .chat-ci__job")].map((job) =>
        job.getAttribute("data-check-id"),
      ),
    ).toEqual(["3", "2", "1"]);
    const failed = container.querySelector<HTMLDetailsElement>('.chat-ci__job[data-check-id="3"]')!;
    expect(failed.open).toBe(true);
    expect(failed.querySelector(".chat-ci__duration")?.textContent).toBe("1m 12s");
    expect(
      [...failed.querySelectorAll(".chat-ci__step .chat-ci__name")].map((step) => step.textContent),
    ).toEqual(["Set up job", "Install", "Lint sources", "Upload report"]);
    expect(
      container.querySelector<HTMLDetailsElement>('.chat-ci__job[data-check-id="1"]')?.open,
    ).toBe(false);
    expect(container.querySelector<HTMLDetailsElement>(".chat-ci__skipped")?.open).toBe(false);
    failed.open = false;
    await settle(h.element);
    const requestsBeforeRefresh = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await h.element.updateComplete;
    expect(h.request).toHaveBeenCalledTimes(requestsBeforeRefresh + 1);
    expect(failed.open).toBe(false);
    h.element.presented = false;
    await settle(h.element);
    const hiddenCount = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).toHaveBeenCalledTimes(hiddenCount);
    h.element.presented = true;
    await settle(h.element);
    expect(h.request).toHaveBeenCalledTimes(hiddenCount + 1);
    expect(h.disclosure.open).toBe(true);
    expect(container.querySelector('.chat-ci__job[data-check-id="3"]')).toBe(failed);
    expect(failed.open).toBe(false);
    h.disclosure.open = false;
    await settle(h.element);
    const closedCount = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).toHaveBeenCalledTimes(closedCount);
  });

  it("refreshes completed CI so same-head reruns replace cached terminal results", async () => {
    const h = harness();
    const completed = details({
      checks: [
        {
          id: 1,
          name: "Build",
          state: "passed",
          status: "completed",
          conclusion: "success",
          source: "actions",
        },
      ],
    });
    const rerun = details({
      checks: [
        { id: 5, name: "Build rerun", state: "running", status: "in_progress", source: "actions" },
      ],
    });
    h.request
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(completed)
      .mockResolvedValue(rerun);
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    expect(h.request).toHaveBeenCalledTimes(1);
    paintChatPullRequests(
      {
        ...h.props,
        pullRequests: [
          pullRequest({
            headSha,
            checks: { state: "pending", passed: 0, failed: 0, skipped: 0, running: 1 },
          }),
        ],
      },
      container,
    );
    await settle(h.element);
    await vi.advanceTimersByTimeAsync(30_000);
    await h.element.updateComplete;
    expect(h.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await h.element.updateComplete;
    expect(container.querySelector('.chat-ci__job[data-check-id="5"]')?.textContent).toContain(
      "Build rerun",
    );
    expect(container.querySelector('.chat-ci__job[data-check-id="1"]')).toBeNull();
  });

  it("aborts a closed monitor and ignores its late response", async () => {
    const h = harness();
    const pending = createDeferred<ControlUiSessionPullRequestCheckDetails>();
    h.request.mockReturnValue(pending.promise);
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    expect(container.querySelector(".chat-ci__jobs")?.getAttribute("aria-busy")).toBe("true");
    const signal = h.request.mock.calls[0]?.[2]?.signal;
    h.disclosure.open = false;
    await settle(h.element);
    expect(signal?.aborted).toBe(true);
    pending.resolve(details());
    await settle(h.element);
    expect(container.querySelector(".chat-ci__job")).toBeNull();
  });

  it("retires pending requests without leaking jobs into a changed session", async () => {
    const h = harness();
    const pending = createDeferred<ControlUiSessionPullRequestCheckDetails>();
    h.request.mockReturnValueOnce(pending.promise);
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    paintChatPullRequests({ ...h.props, sessionKey: "agent:other:main" }, container);
    await settle(h.element);
    pending.resolve(details());
    await settle(h.element);
    expect(h.disclosure.open).toBe(false);
    expect(container.querySelector(".chat-ci__job")).toBeNull();
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it.each(["session", "head", "gateway"] as const)(
    "retires a pending request at native %s replacement before the next DOM commit",
    async (change) => {
      const h = harness();
      const pending = createDeferred<ControlUiSessionPullRequestCheckDetails>();
      h.request.mockReturnValueOnce(pending.promise).mockResolvedValue(details({ checks: [] }));
      await settle(h.element);
      h.disclosure.open = true;
      await settle(h.element);
      const signal = h.request.mock.calls[0]?.[2]?.signal;
      if (change === "session") {
        h.element.sessionKey = "agent:other:main";
      } else if (change === "head") {
        h.element.pullRequest = pullRequest({ headSha: "b".repeat(40) });
      } else {
        h.element.gateway = { ...h.props.gateway };
      }
      expect(signal?.aborted).toBe(true);
      pending.resolve(details());
      await settle(h.element);
      expect(container.querySelector(".chat-ci__job")).toBeNull();
      expect(h.disclosure.open).toBe(change !== "session");
    },
  );

  it.each(["rejected", "unavailable", "stale"] as const)(
    "recovers %s CI reads with bounded backoff, then restores the healthy cadence",
    async (failure) => {
      const h = harness();
      if (failure === "rejected") {
        h.request.mockRejectedValue(
          new GatewayProtocolRequestError({
            code: "UNAVAILABLE",
            message: "GitHub request failed: token=synthetic-secret",
            retryable: true,
            details: { method: "controlUi.sessionPullRequests.checks" },
          }),
        );
      } else {
        h.request.mockResolvedValue(details({ checks: [], status: failure }));
      }
      await settle(h.element);
      h.disclosure.open = true;
      await settle(h.element);
      expect(h.request).toHaveBeenCalledTimes(1);
      for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
        const count = h.request.mock.calls.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(h.request).toHaveBeenCalledTimes(count);
        await vi.advanceTimersByTimeAsync(1);
        await h.element.updateComplete;
        expect(h.request).toHaveBeenCalledTimes(count + 1);
      }
      expect(container.querySelector(".chat-ci__job")).toBeNull();
      expect(container.textContent).not.toContain("synthetic-secret");
      expect(container.querySelector(".panel-feedback, .chat-ci__notice")).toBeNull();
      h.request.mockResolvedValue(details());
      await vi.advanceTimersByTimeAsync(300_000);
      await h.element.updateComplete;
      expect(container.querySelector(".chat-ci__job")).not.toBeNull();
      const recovered = h.request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(h.request).toHaveBeenCalledTimes(recovered);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.request).toHaveBeenCalledTimes(recovered + 1);
    },
  );

  it.each(["hidden", "disconnected"] as const)(
    "cancels scheduled CI recovery while %s and recovers on return",
    async (boundary) => {
      const h = harness();
      h.request.mockRejectedValue(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "Temporary failure",
          retryable: true,
        }),
      );
      await settle(h.element);
      h.disclosure.open = true;
      await settle(h.element);
      expect(h.request).toHaveBeenCalledTimes(1);
      if (boundary === "hidden") {
        h.element.presented = false;
      } else {
        h.setPhase("offline");
      }
      await settle(h.element);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(h.request).toHaveBeenCalledTimes(1);
      h.request.mockResolvedValue(details());
      if (boundary === "hidden") {
        h.element.presented = true;
      } else {
        h.setPhase("connected");
      }
      await settle(h.element);
      expect(h.request).toHaveBeenCalledTimes(2);
      expect(container.querySelector(".chat-ci__job")).not.toBeNull();
    },
  );

  it("honors a server retry delay longer than the local backoff cap", async () => {
    const h = harness();
    h.request.mockResolvedValueOnce(
      details({ checks: [], status: "unavailable", rateLimited: true, retryAfterMs: 600_000 }),
    );
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    expect(h.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(h.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await h.element.updateComplete;
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".chat-ci__job")).not.toBeNull();
  });

  it("does not retry an unclassified failure until the monitor is reopened", async () => {
    const h = harness();
    h.request.mockRejectedValue(new Error("Unexpected response shape"));
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    expect(h.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.disclosure.open = false;
    await settle(h.element);
    h.request.mockResolvedValue(details());
    h.disclosure.open = true;
    await settle(h.element);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".chat-ci__job")).not.toBeNull();
  });

  it("represents non-Actions checks without invented steps or unsafe links", async () => {
    const h = harness();
    h.request.mockResolvedValue(
      details({
        checks: [
          {
            id: 5,
            name: "External audit",
            state: "passed",
            status: "completed",
            source: "check",
            detailsUrl: "javascript:alert(1)",
          },
        ],
      }),
    );
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    expect(container.textContent).toContain("External audit");
    expect(container.querySelector(".chat-ci__empty-steps")).toBeNull();
    expect(container.querySelector(".chat-ci__step")).toBeNull();
    expect(container.querySelector(".chat-ci__job-link")).toBeNull();
    h.request.mockResolvedValue(
      details({
        checks: [
          {
            id: 5,
            name: "External audit",
            state: "passed",
            status: "completed",
            source: "check",
            detailsUrl: "https://ci.example.test/build/5",
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await h.element.updateComplete;
    const link = container.querySelector<HTMLAnchorElement>(".chat-ci__job-link");
    expect(link?.href).toBe("https://ci.example.test/build/5");
    expect(link?.textContent).toContain("Open check details");
  });
});
