/* @vitest-environment jsdom */
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiSessionPullRequestCheckDetails } from "../../../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createGatewayHarness } from "../../../lib/session-pull-requests.test-support.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatCiDetailsElement } from "./chat-ci-details.tsx";
import "./chat-ci-details.tsx";

const pullRequest = {
  owner: "example",
  repo: "project",
  number: 42,
  branch: "feature",
  title: "CI details",
  state: "open" as const,
  url: "https://github.com/example/project/pull/42",
  headSha: "a".repeat(40),
};

function details(
  name: string,
  headSha = pullRequest.headSha,
): ControlUiSessionPullRequestCheckDetails {
  return {
    owner: pullRequest.owner,
    repo: pullRequest.repo,
    number: pullRequest.number,
    headSha,
    status: "ready",
    rateLimited: false,
    checks: [{ id: 1, name, source: "actions", state: "failed", status: "completed", steps: [] }],
  };
}

function mount(pending: Promise<ControlUiSessionPullRequestCheckDetails>) {
  const harness = createGatewayHarness();
  harness.request.mockReturnValue(pending);
  const element = document.createElement("openclaw-chat-ci-details") as ChatCiDetailsElement;
  Object.assign(element, {
    gateway: harness.gateway,
    pullRequest,
    sessionKey: "agent:main:dashboard:ci-details",
    inline: true,
  });
  document.body.append(element);
  onTestFinished(() => element.remove());
  return { element, request: harness.request };
}

it("recovers a delayed read failure silently through the existing retry timer", async () => {
  const read = createDeferred<ControlUiSessionPullRequestCheckDetails>();
  const { element, request } = mount(read.promise);
  await waitForSolid(() => {
    expect(element.querySelector(".chat-ci__jobs")?.getAttribute("aria-busy")).toBe("true");
  });
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  read.reject(
    new GatewayProtocolRequestError({
      code: "UNAVAILABLE",
      message: "CI fixture unavailable",
      retryable: true,
      details: { method: "controlUi.sessionPullRequests.checks" },
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(element.querySelector(".chat-ci__notice")).toBeNull();
  expect(element.querySelector(".chat-ci__jobs")?.getAttribute("aria-description")).toContain(
    "CI fixture unavailable",
  );
  expect(element.querySelector(".chat-ci__jobs")?.getAttribute("aria-busy")).toBe("false");
  request.mockResolvedValueOnce(details("Recovered check"));
  await vi.advanceTimersByTimeAsync(29_999);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await waitForSolid(() => {
    expect(element.querySelector(".chat-ci__job")?.textContent).toContain("Recovered check");
    expect(element.querySelector<HTMLDetailsElement>(".chat-ci__job")?.open).toBe(true);
    expect(element.querySelector(".chat-ci__jobs")?.getAttribute("aria-busy")).toBe("false");
  });
  expect(request).toHaveBeenCalledTimes(2);
});

it("aborts a retired head read and ignores its late answer", async () => {
  const oldRead = createDeferred<ControlUiSessionPullRequestCheckDetails>();
  const { element, request } = mount(oldRead.promise);
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
  const signal = request.mock.calls[0]?.[2]?.signal;
  const nextHead = "b".repeat(40);
  request.mockResolvedValueOnce(details("Current head", nextHead));
  element.pullRequest = { ...pullRequest, headSha: nextHead };
  expect(signal?.aborted).toBe(true);
  await waitForSolid(() => expect(element.textContent).toContain("Current head"));
  oldRead.resolve(details("Retired head"));
  await element.updateComplete;
  await waitForSolid(() => {
    expect(element.textContent).toContain("Current head");
    expect(element.textContent).not.toContain("Retired head");
  });
  expect(request).toHaveBeenCalledTimes(2);
});
