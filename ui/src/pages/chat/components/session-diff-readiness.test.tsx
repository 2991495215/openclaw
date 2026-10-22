/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../../api/gateway.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../../../test-helpers/native-gateways.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { SessionDiffProps } from "./chat-sidebar-content-types.ts";
import { SessionDiffPanel } from "./session-diff-panel.tsx";

function mountPanel() {
  const [props, setProps] = createSignal<SessionDiffProps>({
    owner: null,
    execNode: null,
    loader: null,
    loadFileText: null,
    openFile: null,
    revealFile: null,
  });
  const view = mountSolid(() => <SessionDiffPanel {...props()} />);
  return {
    panel: view.container.querySelector<HTMLElement>("openclaw-session-diff")!,
    unmount: view.unmount,
    update: (patch: Partial<SessionDiffProps>) => setProps((current) => ({ ...current, ...patch })),
  };
}

afterEach(async () => {
  await vi.dynamicImportSettled();
  document.body.replaceChildren();
  clearNativeGatewayTestState();
  vi.restoreAllMocks();
});

function result(branch: string): SessionsDiffResult {
  return {
    sessionKey: "agent:main:test",
    branch,
    baseRef: "main",
    files: [],
    additions: 0,
    deletions: 0,
  };
}

const SNAPSHOT_PATCH = [
  "--- a/example.txt",
  "+++ b/example.txt",
  "@@ -3 +3 @@",
  "-before",
  "+snapshot line",
].join("\n");

const FRESH_PATCH = [
  "--- a/example.txt",
  "+++ b/example.txt",
  "@@ -1,3 +1,3 @@",
  " fresh gap edit",
  " context",
  "-before",
  "+fresh snapshot line",
].join("\n");

function fileResult(patch: string): SessionsDiffResult {
  return {
    sessionKey: "agent:main:test",
    branch: "feature/test",
    baseRef: "main",
    files: [
      {
        path: "example.txt",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch,
      },
    ],
    additions: 1,
    deletions: 1,
  };
}

describe("SessionDiffPanel readiness", () => {
  it("renders a skeleton only while a real diff request is pending", async () => {
    setNativeGatewayTestState(null);
    const pending = deferred<SessionsDiffResult>();
    const { panel, update } = mountPanel();

    flush();
    expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");

    update({
      mobile: false,
      owner: { agentId: "main", sessionKey: "original-session" },
      loader: vi.fn(() => pending.promise),
    });
    await waitForSolid(() => {
      expect(
        panel.querySelector("openclaw-panel-loading-skeleton")?.getAttribute("data-panel-skeleton"),
      ).toBe("review");
      expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("true");
    });

    pending.resolve(result("feature/pending"));
    await waitForSolid(() => expect(panel.textContent).toContain("feature/pending"));
    expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");

    const replacement = deferred<SessionsDiffResult>();
    update({ owner: { agentId: "main", sessionKey: "another-session" } });
    update({ loader: () => replacement.promise });
    flush();
    expect(
      panel.querySelector("openclaw-panel-loading-skeleton")?.getAttribute("data-panel-skeleton"),
    ).toBe("review");
    expect(panel.textContent).not.toContain("feature/pending");
    replacement.resolve(result("feature/replacement"));
    await waitForSolid(() => expect(panel.textContent).toContain("feature/replacement"));

    const failedRead = vi.fn(async () => {
      throw new Error("Diff unavailable");
    });
    update({ loader: failedRead });
    await waitForSolid(() => {
      expect(failedRead).toHaveBeenCalledOnce();
      expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");
    });
    expect(panel.querySelector(".callout.danger")).toBeNull();
    expect(panel.textContent).not.toContain("feature/replacement");
  });

  it.each(["resolve", "reject"])(
    "defers an inactive owner read without holding its sibling's transition: %s",
    async (outcome) => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const pending = deferred<SessionsDiffResult>();
      const loader = vi
        .fn<NonNullable<SessionDiffProps["loader"]>>()
        .mockResolvedValueOnce(result("original"))
        .mockReturnValueOnce(pending.promise);
      const [props, setProps] = createSignal<SessionDiffProps>({
        owner: { agentId: "main", sessionKey: "original-session" },
        active: true,
        mobile: false,
        execNode: null,
        loader,
        loadFileText: null,
        openFile: null,
        revealFile: null,
      });
      const view = mountSolid(() => (
        <>
          <span data-sibling>{props().owner?.sessionKey}</span>
          <SessionDiffPanel {...props()} />
        </>
      ));
      await vi.advanceTimersByTimeAsync(0);
      expect(view.container.textContent).toContain("original");
      setProps((current) => ({
        ...current,
        active: false,
        owner: { agentId: "main", sessionKey: "replacement-session" },
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(view.container.querySelector("[data-sibling]")?.textContent).toBe(
        "replacement-session",
      );
      expect(loader).toHaveBeenCalledTimes(1);

      setProps((current) => ({ ...current, active: true }));
      await vi.advanceTimersByTimeAsync(500);
      expect(loader).toHaveBeenCalledTimes(2);
      if (outcome === "reject") {
        pending.reject(new Error("Deferred diff unavailable"));
        await vi.advanceTimersByTimeAsync(0);
        expect(view.container.querySelector(".callout.danger")).toBeNull();
        expect(view.container.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe(
          "false",
        );
        expect(view.container.querySelector(".session-diff")?.textContent).not.toContain(
          "original",
        );
      } else {
        pending.resolve(result("replacement"));
        await vi.advanceTimersByTimeAsync(0);
        expect(view.container.querySelector(".session-diff")?.textContent).toContain("replacement");
      }
    },
  );

  it("shows loading instead of the old files while a changed scope is pending", async () => {
    const pending = deferred<SessionsDiffResult>();
    const loader = vi
      .fn<NonNullable<SessionDiffProps["loader"]>>()
      .mockResolvedValueOnce(fileResult(SNAPSHOT_PATCH))
      .mockReturnValueOnce(pending.promise);
    const { panel, update } = mountPanel();
    update({ loader });
    await waitForSolid(() => expect(panel.querySelector(".session-diff__file")).not.toBeNull());

    panel.querySelector<HTMLButtonElement>(".session-diff__section-title")!.click();
    await waitForSolid(() =>
      expect(panel.querySelector('button[value="scope:uncommitted"]')).not.toBeNull(),
    );
    panel.querySelector<HTMLButtonElement>('button[value="scope:uncommitted"]')!.click();
    try {
      await waitForSolid(() => {
        expect(panel.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
        expect(panel.querySelector(".session-diff__file")).toBeNull();
      });
      expect(loader).toHaveBeenLastCalledWith({ scope: "uncommitted" });
    } finally {
      pending.resolve(fileResult(FRESH_PATCH));
    }
    await waitForSolid(() => expect(panel.textContent).toContain("fresh snapshot line"));
  });

  it("keeps computing responses pending and retains the last diff during refresh", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const computing = { ...result("feature/test"), computing: true };
    const slow = deferred<SessionsDiffResult>();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const loader = vi
      .fn<NonNullable<SessionDiffProps["loader"]>>()
      .mockResolvedValueOnce(computing)
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(computing)
      .mockResolvedValueOnce(fileResult(FRESH_PATCH));
    const onResult = vi.fn();
    const { panel, update } = mountPanel();
    update({ loader, onResult });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
    expect(panel.textContent).not.toContain("No changes in this session");
    expect(onResult).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(loader).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(loader).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    update({ active: false });
    await vi.advanceTimersByTimeAsync(0);
    update({ active: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(panel.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
    expect(onResult).not.toHaveBeenCalled();
    slow.resolve(fileResult(SNAPSHOT_PATCH));
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.textContent).toContain("snapshot line");
    expect(onResult).toHaveBeenCalledTimes(1);

    panel.querySelector<HTMLButtonElement>(".session-diff__refresh")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.textContent).toContain("snapshot line");
    expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("true");
    expect(onResult).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(panel.textContent).toContain("fresh snapshot line");
    expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("stops computing polls while hidden or inactive and retires them with the request owner", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const loader = vi.fn().mockResolvedValue({ ...result("feature/test"), computing: true });
    const { panel, update, unmount } = mountPanel();
    update({ loader });
    await vi.advanceTimersByTimeAsync(0);
    update({ active: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loader).toHaveBeenCalledTimes(1);
    update({ active: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(loader).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loader).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(loader).toHaveBeenCalledTimes(3);
    update({
      owner: { agentId: "main", sessionKey: "replacement" },
      loader: async () => result("replacement"),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(panel.textContent).toContain("replacement");
    expect(loader).toHaveBeenCalledTimes(3);
    update({ loader });
    await vi.advanceTimersByTimeAsync(0);
    unmount();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it("recovers transient mobile reads through fresh receipts with bounded backoff", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const pending = deferred<SessionsDiffResult>();
    const loader = vi
      .fn<NonNullable<SessionDiffProps["loader"]>>()
      .mockRejectedValueOnce(
        new GatewayRequestError({ code: "UNAVAILABLE", message: "Busy", retryable: true }),
      )
      .mockRejectedValueOnce(
        new GatewayRequestError({ code: "UNAVAILABLE", message: "Still busy", retryable: true }),
      )
      .mockReturnValueOnce(pending.promise);
    const { panel, update } = mountPanel();
    update({ mobile: true, loader, canRead: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(loader).toHaveBeenCalledOnce();
    expect(panel.querySelector(".callout.danger")).toBeNull();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(loader).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(panel.querySelector(".callout.danger")).toBeNull();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(loader).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(loader).toHaveBeenCalledTimes(3);
    expect(panel.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
    expect(panel.querySelector<HTMLButtonElement>(".session-diff__refresh")!.disabled).toBe(true);
    pending.resolve(fileResult(SNAPSHOT_PATCH));
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.textContent).toContain("snapshot line");
    expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("retains cached rows during paused recovery and retires replaced owners", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const unavailable = new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "Busy",
      retryable: true,
    });
    const recovered = deferred<SessionsDiffResult>();
    const loader = vi
      .fn()
      .mockResolvedValueOnce(fileResult(SNAPSHOT_PATCH))
      .mockRejectedValueOnce(unavailable)
      .mockReturnValueOnce(recovered.promise)
      .mockResolvedValue(fileResult(FRESH_PATCH));
    const { panel, update } = mountPanel();
    update({ loader, active: true, canRead: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.textContent).toContain("snapshot line");
    const cachedFile = panel.querySelector(".session-diff__file");
    expect(cachedFile).not.toBeNull();

    panel.querySelector<HTMLButtonElement>(".session-diff__refresh")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(panel.querySelector(".session-diff__file")).toBe(cachedFile);
    expect(panel.textContent).toContain("snapshot line");
    expect(panel.querySelector(".callout.danger")).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    update({ active: false });
    await vi.advanceTimersByTimeAsync(10_000);
    update({ active: true });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(panel.querySelector(".session-diff__file")).toBe(cachedFile);
    await vi.advanceTimersByTimeAsync(1);
    expect(loader).toHaveBeenCalledTimes(3);
    expect(panel.querySelector(".session-diff__file")).toBe(cachedFile);
    expect(panel.textContent).toContain("snapshot line");
    recovered.resolve(fileResult(FRESH_PATCH));
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.textContent).toContain("fresh snapshot line");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(loader).toHaveBeenCalledTimes(3);

    loader.mockRejectedValueOnce(unavailable);
    panel.querySelector<HTMLButtonElement>(".session-diff__refresh")!.click();
    await vi.advanceTimersByTimeAsync(0);
    const replacement = vi.fn().mockResolvedValue(result("replacement"));
    update({
      owner: { agentId: "main", sessionKey: "replacement" },
      loader: replacement,
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(loader).toHaveBeenCalledTimes(4);
    expect(replacement).toHaveBeenCalledOnce();
    expect(panel.textContent).toContain("replacement");
  });

  it("retains same-scope offline data but hides replaced and denied results without retrying", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const loader = vi.fn().mockResolvedValue(fileResult(SNAPSHOT_PATCH));
    const { panel, update } = mountPanel();
    update({ loader, owner: { agentId: "main", sessionKey: "original" }, canRead: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.textContent).toContain("snapshot line");

    update({ canRead: () => false });
    flush();
    panel.querySelector<HTMLButtonElement>(".session-diff__refresh")!.click();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loader).toHaveBeenCalledOnce();
    expect(panel.textContent).toContain("snapshot line");
    expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");

    update({ owner: { agentId: "main", sessionKey: "replacement" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.textContent).not.toContain("snapshot line");
    expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");

    const denied = vi
      .fn()
      .mockResolvedValueOnce(fileResult(FRESH_PATCH))
      .mockRejectedValue(
        new GatewayRequestError({ code: "FORBIDDEN", message: "Denied", retryable: true }),
      );
    update({ loader: denied, canRead: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.textContent).toContain("fresh snapshot line");
    panel.querySelector<HTMLButtonElement>(".session-diff__refresh")!.click();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(denied).toHaveBeenCalledTimes(2);
    expect(panel.textContent).not.toContain("fresh snapshot line");
    expect(panel.querySelector(".callout.danger")).toBeNull();
    expect(panel.querySelector(".session-diff__file")).toBeNull();
    expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");
  });

  it("does not publish an invalid diff RPC result and settles loading silently", async () => {
    const request = createGatewayRequestMock().mockResolvedValue({});
    const client = createTestGatewayClient(request);
    const onResult = vi.fn();
    const { panel, update } = mountPanel();
    update({
      loader: (scope) => client.request<SessionsDiffResult>("sessions.diff", scope),
      onResult,
    });

    await waitForSolid(() => {
      expect(request).toHaveBeenCalledOnce();
      expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");
    });
    expect(onResult).not.toHaveBeenCalled();
    expect(panel.querySelector(".callout.danger")).toBeNull();
    expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    expect(panel.querySelector(".session-diff__file")).toBeNull();
  });
});
