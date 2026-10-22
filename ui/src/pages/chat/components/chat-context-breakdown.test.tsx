// @vitest-environment jsdom
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import { Show, createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { SessionSystemPromptReport } from "../../../../../src/config/sessions/session-system-prompt-report.js";
import { createDeferredCore } from "../../../../../src/shared/deferred.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import * as toast from "../../../lib/toast.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import {
  buildChatContextCategories,
  buildDeferredContextGroups,
} from "./chat-context-breakdown-model.ts";
import { ChatContextBreakdown } from "./chat-context-breakdown.tsx";

const workspaceFile = (path: string, chars = 16000) => ({
  name: "AGENTS.md",
  path,
  missing: false,
  rawChars: chars,
  injectedChars: chars,
  truncated: false,
});
const report: SessionSystemPromptReport = {
  source: "run",
  generatedAt: 1,
  systemPrompt: { chars: 40000, projectContextChars: 16000, nonProjectContextChars: 24000 },
  injectedWorkspaceFiles: [workspaceFile("/private/workspace/AGENTS.md")],
  skills: { promptChars: 8000, entries: [{ name: "review", blockChars: 8000 }] },
  tools: {
    listChars: 0,
    schemaChars: 12000,
    entries: [{ name: "exec", summaryChars: 400, schemaChars: 12000 }],
  },
};
const usage = (key: string, sessionId = key) => ({
  sessions: [{ key: `agent:main:${key}`, sessionId, contextWeight: report }],
});
function expectTokens(value: SessionSystemPromptReport, expected: Array<number | null>) {
  const categories = buildChatContextCategories(value, 50000);
  expect(categories.map(({ id, tokens }) => [id, tokens])).toEqual(
    ["messages", "files", "tools", "skills", "system"].map((id, i) => [id, expected[i]]),
  );
  expect(categories[1]?.groups?.[0]?.kind).toBe("other");
}

it("subtracts embedded prompt sections once, and leaves unmeasured and inconsistent sizes unknown", () => {
  expectTokens(report, [37000, 4000, 3000, 2000, 4000]);
  expect(buildChatContextCategories(report, 1000)[0]?.tokens).toBeNull();
  const native = structuredClone(report);
  Object.assign(native.injectedWorkspaceFiles[0]!, {
    path: "/private/AGENTS.md",
    injectionStatus: "native_unverified",
    injectedChars: null,
    truncated: null,
  });
  expectTokens(native, [null, null, 3000, 2000, null]);
});

it("retires a pending report on session replacement and rejects a report from another incarnation", async () => {
  const first = createDeferredCore<ReturnType<typeof usage>>();
  let signal: AbortSignal | undefined;
  let requestIndex = 0;
  const request = createGatewayRequestMock((method, params, options) => {
    const firstRequest = requestIndex++ === 0;
    expect(method).toBe("sessions.usage");
    expect(params).toMatchObject({ key: `agent:main:${firstRequest ? "first" : "second"}` });
    if (firstRequest) {
      signal = options?.signal;
      return first.promise;
    }
    return usage("second", "retired");
  });
  const { gateway, publish } = createApplicationGateway();
  const client = createTestGatewayClient(request);
  publish({ ...gateway.snapshot, phase: "connected", client });
  const [session, setSession] = createSignal<GatewaySessionRow>({
    key: "agent:main:first",
    kind: "direct",
    sessionId: "first",
  });
  const view = mountSolid(() => (
    <ChatContextBreakdown gateway={gateway} session={session()} used={50000} limit={100000} />
  ));
  await expect.poll(() => request.mock.calls.length).toBe(1);
  setSession({ key: "agent:main:second", kind: "direct", sessionId: "current" });
  flush();
  await view.findByRole("button", { name: "Refresh" });
  expect(signal?.aborted).toBe(true);
  first.resolve(usage("first"));
  await first.promise;
  flush();
  expect(view.container.textContent).not.toContain("AGENTS.md");
  expect(view.container.querySelector(".chat-context__bar")).toBeNull();
  view.unmount();
});

it("groups duplicate filenames by producer origin and keeps deferred schemas outside usage", () => {
  const grouped = structuredClone(report);
  grouped.injectedWorkspaceFiles[0]!.origin = {
    kind: "agent-workspace",
    rootPath: "/private/workspace",
  };
  grouped.injectedWorkspaceFiles.push({
    ...workspaceFile("/project/AGENTS.md", 4000),
    origin: { kind: "execution-project", rootPath: "/project" },
  });
  grouped.tools.entries = [
    { name: "exec", summaryChars: 400, schemaChars: 8000, source: "openclaw" },
    { name: "read", summaryChars: 400, schemaChars: 4000, source: "mcp", serverName: "Docs" },
  ];
  grouped.tools.deferred = {
    schemaChars: 40000,
    entries: [
      { name: "search", source: "mcp", serverName: "Docs", schemaChars: 40000 },
      { name: "remote", source: "client", schemaChars: null },
    ],
  };
  const categories = buildChatContextCategories(grouped, 50000);
  const groups = (id: string) => categories.find((category) => category.id === id)?.groups;
  expect(
    groups("files")?.map((group) => [group.kind, group.tokens, group.entries[0]?.key]),
  ).toEqual([
    ["agent-workspace", 4000, "/private/workspace/AGENTS.md"],
    ["execution-project", 1000, "/project/AGENTS.md"],
  ]);
  expect(groups("tools")?.map((group) => [group.kind, group.name, group.tokens])).toEqual([
    ["openclaw", undefined, 2000],
    ["mcp", "Docs", 1000],
  ]);
  expect(categories.reduce((sum, category) => sum + (category.tokens ?? 0), 0)).toBe(50000);
  expect(buildDeferredContextGroups(grouped).map((group) => [group.kind, group.tokens])).toEqual([
    ["mcp", 10000],
    ["client", null],
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function advance(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

function mountRecoveringContext(request: ReturnType<typeof createGatewayRequestMock>) {
  const { gateway, publish } = createApplicationGateway();
  const client = createTestGatewayClient(request);
  publish({ ...gateway.snapshot, phase: "connected", client });
  const [presented, setPresented] = createSignal(true);
  const [used, setUsed] = createSignal(50000);
  const view = mountSolid(() => (
    <Show when={presented()}>
      <ChatContextBreakdown
        gateway={gateway}
        session={{ key: "agent:main:task", kind: "direct", sessionId: "task" }}
        used={used()}
        limit={100000}
      />
    </Show>
  ));
  onTestFinished(view.unmount);
  return { ...view, gateway, publish, setPresented, setUsed };
}

it("bounds failed reads, coalesces in-flight recovery, and stops reading once healthy", async () => {
  vi.useFakeTimers();
  const pending = createDeferredCore<ReturnType<typeof usage>>();
  const request = createGatewayRequestMock().mockRejectedValue(
    new GatewayProtocolRequestError({ code: "UNAVAILABLE", retryable: true }),
  );
  const view = mountRecoveringContext(request);
  await advance();
  expect(request).toHaveBeenCalledTimes(1);
  await advance(29999);
  expect(request).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(request).toHaveBeenCalledTimes(2);
  await advance(59999);
  expect(request).toHaveBeenCalledTimes(2);
  await advance(1);
  expect(request).toHaveBeenCalledTimes(3);
  await advance(210000);
  expect(request).toHaveBeenCalledTimes(4); // Initial request plus three retries in five minutes.
  await advance(300000);
  expect(request).toHaveBeenCalledTimes(5); // Four retries in ten minutes.
  request.mockReturnValueOnce(pending.promise);
  await advance(150000);
  expect(request).toHaveBeenCalledTimes(6);
  await advance(600000);
  expect(request).toHaveBeenCalledTimes(6);
  pending.resolve(usage("task"));
  await advance();
  expect(view.container.querySelector(".chat-context__bar")).not.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await advance(600000);
  expect(request).toHaveBeenCalledTimes(6);
  const visibility = vi.spyOn(document, "visibilityState", "get");
  for (const state of ["hidden", "visible"] as const) {
    visibility.mockReturnValue(state);
    document.dispatchEvent(new Event("visibilitychange"));
    await advance();
  }
  expect(request).toHaveBeenCalledTimes(6);
  view.getByRole("button", { name: "Refresh" }).click();
  await advance();
  expect(request).toHaveBeenCalledTimes(7);
  request.mockResolvedValue(usage("task"));
  await advance(29999);
  expect(request).toHaveBeenCalledTimes(7);
  await advance(1);
  expect(request).toHaveBeenCalledTimes(8);
  expect(view.container.querySelector(".chat-context__bar")).not.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["refresh", "usage update"])(
  "retains the report after a failed %s and retires denied scopes",
  async (trigger) => {
    const notify = vi.spyOn(toast, "showToast").mockReturnValue(true);
    vi.useFakeTimers();
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(usage("task"))
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({ code: "UNAVAILABLE", retryable: true }),
      )
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Denied" }),
      )
      .mockRejectedValue(new GatewayProtocolRequestError({ code: "UNAVAILABLE", retryable: true }));
    const view = mountRecoveringContext(request);
    await advance();
    expect(view.container.querySelector(".chat-context__bar")).not.toBeNull();
    if (trigger === "refresh") {
      view.getByRole("button", { name: "Refresh" }).click();
    } else {
      view.setUsed(60000);
    }
    await advance();
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector(".chat-context__bar")).not.toBeNull();
    expect(notify).toHaveBeenCalledTimes(trigger === "refresh" ? 1 : 0);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(600000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await advance();
    expect(request).toHaveBeenCalledTimes(3);
    expect(view.container.querySelector(".chat-context__bar")).toBeNull();
    expect(view.container.textContent).not.toMatch(/Denied|Couldn't load|Retry/);
    expect(notify).toHaveBeenCalledTimes(trigger === "refresh" ? 1 : 0);
    await advance(600000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    const connected = view.gateway.snapshot;
    view.publish({ ...connected, phase: "offline", client: null });
    flush();
    view.publish(connected);
    await advance();
    expect(request).toHaveBeenCalledTimes(4);
    view.setPresented(false);
    flush();
    await advance(600000);
    expect(request).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    view.setPresented(true);
    await advance();
    expect(request).toHaveBeenCalledTimes(5);
    view.unmount();
    await advance(600000);
    expect(request).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([30_000, 600_000])(
  "preserves the %i ms retry deadline across visibility changes",
  async (delay) => {
    vi.useFakeTimers();
    const request = createGatewayRequestMock()
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          retryable: true,
          retryAfterMs: delay,
        }),
      )
      .mockRejectedValueOnce(
        new GatewayProtocolRequestTimeoutError({
          method: "sessions.usage",
          timeoutMs: 30_000,
          requestSent: true,
        }),
      )
      .mockResolvedValue(usage("task"));
    const view = mountRecoveringContext(request);
    await advance();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(delay / 2);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(delay / 2 - 1);
    expect(request).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(request).toHaveBeenCalledTimes(2);
    await advance(59_999);
    expect(request).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(view.container.querySelector(".chat-context__bar")).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  },
);
