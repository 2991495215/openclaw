/* @vitest-environment jsdom */
import { createComponent, createSignal, flush, untrack } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { GatewayRequestError } from "../../../api/gateway.ts";
import type { GatewayRequestHandler } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import { ChatDetailsEnvironmentMobile } from "./chat-details-environment-mobile.tsx";
import { ChatDetailsEnvironment } from "./chat-details-environment.tsx";
import { resolveSessionWorkspaceDiff } from "./chat-session-workspace-diff.ts";
import { getSessionWorkspace } from "./chat-session-workspace-state.ts";
import type { SessionWorkspaceHost } from "./chat-session-workspace-types.ts";

function diffFixture(request: GatewayRequestHandler) {
  const state: SessionWorkspaceHost = {
    sessionKey: "agent:main:workspace",
    connected: true,
    connectionEpoch: 1,
    hello: gatewayHelloForMethods(["sessions.diff"]),
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    client: createGatewayBrowserClientFixture({ request }),
    sessions: createSessionCapabilityFixture({}),
    sidebarContent: null,
    handleOpenSidebar: () => {},
  };
  const resolve = () => {
    const value = resolveSessionWorkspaceDiff(state, () => undefined);
    if (value?.kind !== "session-diff") {
      throw new Error("Missing checkout diff");
    }
    return value;
  };
  return { state, resolve };
}

it.each([false, true])(
  "Environment preserves recovery across leases and retirement (mobile=%s)",
  async (mobile) => {
    vi.useFakeTimers();
    const start = Date.now();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: () => ({ cancel() {} }),
    });
    onTestFinished(() => {
      visibility.mockRestore();
      vi.useRealTimers();
      if (descriptor) {
        Object.defineProperty(Element.prototype, "animate", descriptor);
      } else {
        Reflect.deleteProperty(Element.prototype, "animate");
      }
    });
    const result = { sessionKey: "agent:main:workspace", files: [], additions: 1, deletions: 0 };
    const unavailable = new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "Busy",
      retryable: true,
      retryAfterMs: 600_000,
    });
    const request = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValue(result);
    const { state, resolve } = diffFixture(request);
    const [content, setContent] = createSignal(resolve());
    const [presented, setPresented] = createSignal(true);
    const [expanded, setExpanded] = createSignal(true);
    const mounted = mountSolid(() =>
      createComponent(mobile ? ChatDetailsEnvironmentMobile : ChatDetailsEnvironment, {
        details: {
          sessionKey: state.sessionKey,
          currentAgentId: "main",
          selectedSession: { key: state.sessionKey, kind: "direct" },
          messages: [],
          detailsWorkspace: {
            root: "/synthetic/project",
            label: "project",
            branch: "feature/recovery",
          },
        },
        get presented() {
          return presented();
        },
        get expanded() {
          return expanded();
        },
        get onRequestUncommitted() {
          return content().requestUncommitted;
        },
        get uncommitted() {
          return content().uncommitted;
        },
      }),
    );
    const settle = async () => {
      flush();
      await vi.advanceTimersByTimeAsync(0);
      flush();
    };
    await settle();
    expect(request).toHaveBeenCalledOnce();
    const presentation = { ...untrack(content) };
    getSessionWorkspace(state).diffContent = presentation;
    setContent(presentation);
    presentation.onResult?.({ owner: presentation.owner, scope: { scope: "all" }, result });

    await vi.advanceTimersByTimeAsync(10_000);
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(request).toHaveBeenCalledOnce();
    const stopExtra = untrack(content).requestUncommitted?.();
    await settle();
    expect(request).toHaveBeenCalledOnce();
    if (stopExtra) {
      stopExtra();
    }
    setPresented(false);
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    setPresented(true);
    await settle();
    expect(request).toHaveBeenCalledOnce();
    if (!mobile) {
      setExpanded(false);
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      setExpanded(true);
      await settle();
      expect(request).toHaveBeenCalledOnce();
    }
    await vi.advanceTimersByTimeAsync(600_000 - (Date.now() - start) - 1);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(untrack(content).uncommitted).toBe(result);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(2);
    setPresented(false);
    await settle();
    request.mockRejectedValueOnce(unavailable);
    setPresented(true);
    await settle();
    expect(request).toHaveBeenCalledTimes(3);
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(3);
    state.connectionEpoch++;
    request.mockResolvedValueOnce({ ...result, computing: true }).mockResolvedValue(result);
    setContent(resolve());
    await settle();
    expect(request).toHaveBeenCalledTimes(3);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(5);
    setPresented(false);
    await settle();
    request.mockRejectedValueOnce(unavailable);
    setPresented(true);
    await settle();
    expect(request).toHaveBeenCalledTimes(6);
    request.mockRejectedValueOnce(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Still busy",
        retryable: true,
        retryAfterMs: 1_200_000,
      }),
    );
    await expect(
      untrack(content).load({ scope: "uncommitted" }, { refresh: true }),
    ).rejects.toThrow("Still busy");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(7);
    await untrack(content).load({ scope: "uncommitted" }, { refresh: true });
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(request).toHaveBeenCalledTimes(8);
    mounted.unmount();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(8);
  },
);

it.each(["failure", "computing"] as const)(
  "retires the old computing poll when Review refresh returns %s",
  async (outcome) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const result = { sessionKey: "agent:main:workspace", files: [], additions: 0, deletions: 0 };
    const computing = { ...result, computing: true };
    const unavailable = new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "Busy",
      retryable: true,
      retryAfterMs: 600_000,
    });
    const request = vi.fn().mockResolvedValueOnce(computing);
    if (outcome === "failure") {
      request.mockRejectedValueOnce(unavailable);
    } else {
      request.mockResolvedValueOnce(computing).mockResolvedValueOnce(computing);
    }
    request.mockResolvedValue(result);
    const content = diffFixture(request).resolve();
    const release = content.requestUncommitted?.();
    onTestFinished(() => {
      if (release) {
        release();
      }
    });
    await vi.advanceTimersByTimeAsync(100);
    const refresh = content.load({ scope: "uncommitted" }, { refresh: true });
    if (outcome === "failure") {
      await expect(refresh).rejects.toThrow("Busy");
    } else {
      await refresh;
    }
    await vi.advanceTimersByTimeAsync(400);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(outcome === "failure" ? 599_600 : 100);
    expect(request).toHaveBeenCalledTimes(3);
    if (outcome === "computing") {
      await vi.advanceTimersByTimeAsync(499);
      expect(request).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(4);
    }
    expect(content.uncommitted).toBe(result);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(outcome === "failure" ? 3 : 4);
  },
);
