/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import {
  buildSystemAgentSessionInvalidatedErrorDetails,
  type SystemAgentChatResult,
  type SystemChangesListResult,
} from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { channelSnapshotEntryIsActive, createChannelCapability } from "../../lib/channels/index.ts";
import * as uuid from "../../lib/uuid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

type Reply = SystemAgentChatResult;
function chatReply(reply: string, patch: Partial<Reply> = {}): Reply {
  return { sessionId: "custodian-session", reply, action: "none", ...patch };
}

function channelSnapshot(patch: Partial<ChannelsStatusSnapshot> = {}): ChannelsStatusSnapshot {
  return {
    ts: 1_700_000_000_000,
    channelOrder: ["telegram"],
    channelLabels: { telegram: "Telegram" },
    channels: { telegram: { configured: false, running: false, connected: false } },
    channelAccounts: { telegram: [] },
    channelDefaultAccountId: {},
    ...patch,
  };
}

type Page = Awaited<ReturnType<typeof mountPage>>["page"];
const wizard = ".custodian__wizard-step";
const channelNudge = ".custodian__nudge--channel-onboarding";
const nudgeCta = ".custodian__nudge-cta";
const history = ".custodian__history";
const historyToggle = ".custodian__history-toggle";
const historyMore = ".custodian__history-more";
const password = 'input[type="password"]';
const question = {
  id: "credential",
  header: "Credential",
  question: "Choose authentication.",
  options: [{ label: "Enter credential", reply: "enter" }, { label: "Use environment" }],
};
const step: NonNullable<Reply["step"]> = {
  id: "credential",
  type: "text",
  message: "Credential",
  sensitive: true,
};
const secret = "test-token-placeholder";

function button(page: HTMLElement, selector: string) {
  return page.querySelector<HTMLButtonElement>(selector)!;
}
async function element<T extends HTMLElement>(page: HTMLElement, selector: string): Promise<T> {
  return waitForFast(() => {
    const found = page.querySelector<T>(selector);
    expect(found).not.toBeNull();
    return found!;
  });
}
async function mount(
  request: Parameters<typeof createContext>[0],
  methods?: Parameters<typeof createContext>[1],
  options?: Parameters<typeof createContext>[2],
  pageOptions?: Parameters<typeof mountPage>[1],
) {
  const harness = createContext(request, methods, options);
  return { ...harness, ...(await mountPage(harness.context, pageOptions)) };
}
function expectMethods(request: Mock, ...methods: string[]) {
  expect(request.mock.calls.map(([method]) => method)).toEqual(methods);
}
function wizardReply(wizardStep: NonNullable<Reply["step"]>) {
  return chatReply("Ready.", {
    wizardInputPending: true,
    step: wizardStep,
    sensitive: wizardStep.sensitive,
  });
}
const optionLabels = (...labels: string[]) =>
  labels.map((label) => ({ label, value: label.toLowerCase() }));
function replies(...values: unknown[]) {
  const request = vi.fn();
  for (const value of values) {
    if (value instanceof Error) {
      request.mockRejectedValueOnce(value);
    } else {
      request.mockResolvedValueOnce(value);
    }
  }
  return request;
}
function expectFreshSession(request: Mock, index: number) {
  expect(request.mock.calls[index]?.[1]).toMatchObject({
    sessionId: expect.stringMatching(/^control-ui-onboarding-/),
  });
  expect(request.mock.calls[index]?.[1]).not.toHaveProperty("message");
}
const historyMethods = ["openclaw.chat", "openclaw.chat.history"];
const changesMethods = ["openclaw.chat", "openclaw.changes.list"];
function historyRows(...turns: Array<["user" | "assistant", string, number]>) {
  return { turns: turns.map(([role, text, at]) => ({ role, text, at })) };
}
function change(
  id: string,
  summary: string,
  patch: Partial<SystemChangesListResult["entries"][number]> = {},
) {
  return {
    id,
    summary,
    at: 1_700_000_000_000,
    kind: "config-write" as const,
    source: "config-rpc" as const,
    ...patch,
  };
}
async function send(page: Page, text: string) {
  await fill(page, "textarea", text);
  button(page, ".chat-send-btn").click();
}
function expectWizardAnswer(request: Mock, index: number, stepId: string, value: unknown) {
  expect(request.mock.calls[index]?.[1]).toMatchObject({ wizardAnswer: { stepId, value } });
  expect(request.mock.calls[index]?.[1]).not.toHaveProperty("message");
}
async function fill(page: Page, selector: string, value: string) {
  const field = await element<HTMLInputElement | HTMLTextAreaElement>(page, selector);
  field.value = value;
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await page.updateComplete;
  return field;
}
async function ready(initial: Partial<Reply>, ...outcomes: unknown[]) {
  const request = replies(
    chatReply("Ready.", { sessionId: "engine-session", ...initial }),
    ...outcomes,
  );
  const harness = await mount(request);
  await waitForFast(() => expect(harness.page.store.canSend).toBe(true));
  return { ...harness, request };
}

beforeEach(() => {
  // Start each page with a fresh session identity.
  localStorage.clear();
  vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("custodian page", () => {
  it("renders and answers rich select, multiselect, and sensitive text wizard steps", async () => {
    const request = replies(
      wizardReply({
        id: "channel",
        type: "select",
        options: optionLabels("Discord", "Slack", "Telegram", "WhatsApp", "Twitch"),
      }),
      wizardReply({
        id: "features",
        type: "multiselect",
        options: optionLabels("Chat", "Moderation", "Announcements"),
      }),
      wizardReply({ ...step, id: "secret" }),
      chatReply("Setup complete."),
    );
    const { page } = await mount(request);
    const trigger = await element<HTMLButtonElement>(page, `${wizard} .picker-select__trigger`);
    expect(page.querySelector(".chat-read-aloud-btn")).toBeNull();
    expect(page.querySelector("openclaw-option-card")).toBeNull();
    expect(page.querySelector(".agent-chat__composer-shell")).toBeNull();
    trigger.click();
    await element(page, `${wizard} [role="option"]`);
    [...page.querySelectorAll<HTMLElement>(`${wizard} [role="option"]`)]
      .find((option) => option.textContent?.includes("Twitch"))!
      .click();
    await element(page, `${wizard} input[type="checkbox"]`);
    expectWizardAnswer(request, 1, "channel", "twitch");
    for (const index of [0, 2]) {
      page.querySelectorAll<HTMLInputElement>(`${wizard} input[type="checkbox"]`)[index]!.click();
      await page.updateComplete;
    }
    button(page, `${wizard} .btn.primary`).click();
    const secretInput = await element<HTMLInputElement>(page, password);
    expect(request.mock.calls[2]?.[1].wizardAnswer).toEqual({
      stepId: "features",
      value: ["chat", "announcements"],
    });
    expect(secretInput.type).toBe("password");
    button(page, `${wizard} button[aria-label="Reveal value"]`).click();
    await page.updateComplete;
    expect(page.querySelector<HTMLInputElement>("#custodian-wizard-input-5")!.type).toBe("text");
    await fill(page, "#custodian-wizard-input-5", secret);
    button(page, `${wizard} .btn.primary`).click();
    await waitForFast(() => expect(page.textContent).toContain("Setup complete."));
    expectWizardAnswer(request, 3, "secret", secret);
    expect(page.textContent).toContain("Twitch");
    expect(page.textContent).toContain("Chat, Announcements");
    expect(page.textContent).toContain("Sensitive reply sent");
    expect(page.textContent).not.toContain(secret);
    expect(page.querySelector(".agent-chat__composer-shell")).not.toBeNull();
  });
  it("keeps loaded transcript rows while retrying the welcome without reloading history", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(historyRows(["assistant", "Loaded transcript row", 1]))
      .mockRejectedValueOnce(new Error("temporary welcome failure"))
      .mockResolvedValueOnce(chatReply("Recovered welcome."));
    const { page } = await mount(request, historyMethods);
    await waitForFast(() => expect(page.querySelector('[role="alert"] button')).not.toBeNull());

    button(page, '[role="alert"] button').click();
    await waitForFast(() => expect(page.textContent).toContain("Recovered welcome."));

    expectMethods(request, "openclaw.chat.history", "openclaw.chat", "openclaw.chat");
    expect(page.textContent).toContain("Loaded transcript row");
  });

  it("clears stale rows and cold-starts against the new gateway after credentials change", async () => {
    const request = replies(
      historyRows(["assistant", "Old gateway transcript", 1]),
      chatReply("Enter the token.", { sensitive: true }),
      createDeferred<never>().promise,
    );
    const replacementRequest = replies(
      historyRows(["assistant", "New gateway transcript", 2]),
      chatReply("Fresh safe welcome."),
    );
    const { page, setGatewaySnapshot, setGatewayToken, emitGatewayEvent } = await mount(
      request,
      historyMethods,
      undefined,
      { onboarding: false },
    );
    await fill(page, password, secret);
    button(page, ".chat-send-btn").click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { telegram: { configured: true, running: true, connected: false } },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).not.toBeNull();
    setGatewayToken("new-operator-token");
    setGatewaySnapshot({
      client: createContext(replacementRequest, historyMethods).context.gateway.snapshot.client,
    });
    await waitForFast(() => expect(page.textContent).toContain("Fresh safe welcome."));
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: "custodian-session",
      message: secret,
    });
    expectFreshSession(replacementRequest, 1);
    expect(page.textContent).toContain("New gateway transcript");
    for (const stale of [
      "Old gateway transcript",
      "Enter the token.",
      "Sensitive reply sent",
      secret,
    ]) {
      expect(page.innerHTML).not.toContain(stale);
    }
    expect(page.querySelector(password)).toBeNull();
    expect(page.querySelector(".custodian__nudge")).toBeNull();
    emitGatewayEvent({
      event: "health",
      payload: {
        configReload: { hotReloadStatus: "disabled" },
        channels: {},
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain(
      "Configuration reload stopped",
    );
  });
  it("exits onboarding locally when the question declares an exit skip action", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        chatReply("Choose.", { question: { ...question, isOther: true, skipAction: "exit" } }),
      );
    const { context, page } = await mount(request);
    await element(page, ".option-card__skip");
    button(page, ".option-card__skip").click();

    expect(context.navigate).toHaveBeenCalledWith("chat");
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps replacement-connection history when the previous request finishes late", async () => {
    const pending = createDeferred<SystemChangesListResult>();
    const request = vi.fn((method: string) =>
      method === "openclaw.changes.list" ? pending.promise : Promise.resolve(chatReply("Ready.")),
    );
    const harness = createContext(request, changesMethods);
    const { page } = await mountPage(harness.context, { onboarding: false });
    button(page, historyToggle).click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("openclaw.changes.list", { limit: 50 }),
    );

    const entry = change("config-audit:replacement", "Replacement connection history");
    const nextRequest = vi.fn(async (method: string) =>
      method === "openclaw.chat.history"
        ? { turns: [] }
        : method === "openclaw.changes.list"
          ? { entries: [entry] }
          : chatReply("Ready."),
    );
    harness.setGatewaySnapshot({
      // SAFETY: This fixture supplies the request method used by the mounted page.
      client: { request: nextRequest } as unknown as GatewayBrowserClient,
    });
    await waitForFast(() => expect(page.querySelector(history)).toBeNull());
    button(page, historyToggle).click();
    await waitForFast(() =>
      expect(page.querySelector(history)?.textContent).toContain(entry.summary),
    );
    pending.resolve({
      entries: [{ ...entry, id: "config-audit:old", summary: "Retired history" }],
    });
    await pending.promise;
    await page.updateComplete;
    expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(1);
    expect(page.querySelector(history)?.textContent).toContain(entry.summary);
    expect(page.querySelector(history)?.textContent).not.toContain("Retired history");
  });
  it("hands off to agent chat and closes the panel", async () => {
    const request = vi.fn().mockResolvedValue(chatReply("Continue.", { action: "open-agent" }));
    const { context } = createContext(request);
    const closePanel = vi.fn();
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, closePanel, { once: true });
    await mountPage(context);
    await waitForFast(() =>
      expect(context.navigate).toHaveBeenCalledWith("chat", {
        pathname: "/chat/main",
        search: "?__openclawComposerFocus=1",
      }),
    );
    expect(closePanel).toHaveBeenCalledWith(expect.objectContaining({ detail: { open: false } }));
  });

  it.each(["dismiss", "channels"])("consumes the optional channel nudge via %s", async (action) => {
    const request = vi.fn().mockResolvedValue(chatReply("Your AI is ready."));
    const { page, context, setChannelsSnapshot, setChannelsConnected } = await mount(
      request,
      undefined,
      {
        channelsSnapshot: channelSnapshot(),
      },
    );
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    button(
      page,
      action === "dismiss" ? 'button[aria-label="Keep using the web app"]' : nudgeCta,
    ).click();
    await page.updateComplete;
    if (action === "dismiss") {
      setChannelsSnapshot(null);
      setChannelsConnected(false);
      setChannelsConnected(true);
      expect(context.channels.refresh).not.toHaveBeenCalled();
      expect(context.replace).toHaveBeenCalledWith("custodian");
    } else {
      expect(context.navigate).toHaveBeenCalledWith("channels");
      expect(context.replace).not.toHaveBeenCalled();
    }
    expect(page.querySelector(channelNudge)).toBeNull();
  });

  it.each(["reconnect", "retry"])("awaits fresh channel status during %s", async (mode) => {
    const initial = createDeferred<ChannelsStatusSnapshot>();
    const fresh = createDeferred<ChannelsStatusSnapshot>();
    const status =
      mode === "reconnect"
        ? replies(channelSnapshot(), new Error("status unavailable"), fresh.promise)
        : replies(initial.promise, fresh.promise);
    const request = vi.fn((method: string) =>
      method === "channels.status" ? status() : Promise.resolve(chatReply("Ready.")),
    );
    const { context, setGatewaySnapshot } = createContext(request);
    const channels = createChannelCapability(context.gateway);
    Object.assign(context, { channels });
    if (mode === "reconnect") {
      await channels.refresh();
      await channels.refresh();
    } else {
      void channels.refresh();
    }
    const previous = channels.state.channelsSnapshot;
    const { page } = await mountPage(context);
    if (mode === "reconnect") {
      expect(previous).not.toBeNull();
      expect(channels.state.channelsError).toBe("status unavailable");
      setGatewaySnapshot({ phase: "reconnecting" });
      setGatewaySnapshot({ phase: "connected" });
      await waitForFast(() => expect(status).toHaveBeenCalledTimes(3));
      expect(channels.state.channelsSnapshot).toBe(previous);
      await waitForFast(() => expect(page.querySelector(channelNudge)).toBeNull());
    } else {
      expect(page.querySelector(channelNudge)).toBeNull();
      initial.reject(new Error("status unavailable"));
      await waitForFast(() => expect(button(page, nudgeCta).textContent).toContain("Retry"));
      button(page, nudgeCta).click();
      await waitForFast(() => expect(status).toHaveBeenCalledTimes(2));
      expect(page.querySelector('[role="alert"]')).not.toBeNull();
      await waitForFast(() => expect(button(page, nudgeCta).disabled).toBe(true));
      expect(button(page, nudgeCta).textContent).toContain("Loading");
    }
    expect(channels.state.channelsLoading).toBe(true);
    fresh.resolve(
      channelSnapshot(
        mode === "reconnect"
          ? { channels: { telegram: { configured: true, running: true, connected: true } } }
          : {
              channelAccounts: {
                telegram: [{ accountId: "work", configured: false, connected: true }],
              },
            },
      ),
    );
    await waitForFast(() => expect(channels.state.channelsLoading).toBe(false));
    expect(channels.state.channelsError).toBeNull();
    expect(channelSnapshotEntryIsActive(channels.state.channelsSnapshot, "telegram")).toBe(true);
    expect(page.querySelector(channelNudge)).toBeNull();
    channels.dispose();
  });

  it("shows advertised recent changes and loads a short cursor page inline", async () => {
    const entries = [
      change("operation", "Set gateway.port", {
        changedPaths: ["gateway.port"],
      }),
      change("external", "External edit", {
        invalid: true,
        opaqueChange: true,
      }),
    ];
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "openclaw.chat") {
        return chatReply("Hello.");
      }
      if (method === "openclaw.changes.list" && !params.beforeCursor) {
        return { entries, nextCursor: "next-page" };
      }
      if (method === "openclaw.changes.list" && params.beforeCursor === "next-page") {
        return { entries: [change("settings", "Settings updated")] };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const { page, setGatewaySnapshot } = await mount(request, changesMethods, undefined, {
      onboarding: false,
    });
    button(page, historyToggle).click();
    await waitForFast(() =>
      expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(2),
    );
    expect(page.querySelector(".custodian__change-paths")?.hasAttribute("open")).toBe(false);
    const warning = page.querySelector(".custodian__change-card.is-invalid")!.textContent;
    expect(warning).toContain("did not pass configuration validation");
    expect(warning).toContain("Formatting or comments changed");
    button(page, historyMore).click();
    await waitForFast(() =>
      expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(3),
    );
    expect(request).toHaveBeenLastCalledWith("openclaw.changes.list", {
      limit: 50,
      beforeCursor: "next-page",
    });
    expect(page.querySelector(historyMore)).toBeNull();
    button(page, historyToggle).click();
    await page.updateComplete;
    button(page, historyToggle).click();
    await waitForFast(() =>
      expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(2),
    );
    expect(request).toHaveBeenLastCalledWith("openclaw.changes.list", { limit: 50 });
    setGatewaySnapshot({ client: { request } as unknown as GatewayBrowserClient });
    await waitForFast(() => expect(page.querySelector(history)).toBeNull());
    expect(page.querySelector(historyToggle)?.getAttribute("aria-expanded")).toBe("false");
  });
  it.each([
    { pathname: "/settings/channels", expectedPage: "channels" },
    { pathname: "/not-an-openclaw-route", expectedPage: undefined },
  ])(
    "adds resolved page context only to user turns at $pathname",
    async ({ pathname, expectedPage }) => {
      window.history.replaceState({}, "", pathname);
      const request = vi.fn().mockResolvedValue(chatReply("Ready."));
      const { page } = await mount(request);
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
      expect(request.mock.calls[0]?.[1]).not.toHaveProperty("context");
      await send(page, "What about this page?");
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      expect(request.mock.calls[1]?.[1]?.message).toBe("What about this page?");
      if (expectedPage) {
        expect(request.mock.calls[1]?.[1]?.context).toEqual({ page: expectedPage });
      } else {
        expect(request.mock.calls[1]?.[1]).not.toHaveProperty("context");
      }
    },
  );

  it("hides typed cancel when the Gateway does not advertise it", async () => {
    const request = vi.fn().mockResolvedValue(wizardReply(step));
    const { context } = createContext(request, ["openclaw.chat"], { gatewayCapabilities: [] });
    const { page } = await mountPage(context);
    await element(page, wizard);
    expect(page.querySelector(".custodian__wizard-cancel")).toBeNull();
    await page.store.cancelWizardStep(page.store.messages.at(-1)!);
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps an unanswered structured question across a same-client reconnect", async () => {
    const request = vi.fn(async (method: string) =>
      method === "openclaw.chat.history"
        ? historyRows(["assistant", "Earlier row", 1])
        : chatReply("NO_REPLY", { question: { ...question, isOther: false } }),
    );
    const { page, setGatewaySnapshot } = await mount(request, historyMethods);
    await element(page, "openclaw-option-card");
    setGatewaySnapshot({ phase: "reconnecting" });
    await page.updateComplete;
    setGatewaySnapshot({ phase: "connected" });
    await page.updateComplete;
    expectMethods(request, "openclaw.chat.history", "openclaw.chat");
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    expect(page.textContent).toContain("NO_REPLY");
    expect(page.textContent).toContain("Choose authentication.");
  });
});

describe("custodian page session lifecycle", () => {
  const reply = (text: string) => chatReply(text, { sessionId: "engine-session" });
  const invalidated = (code: "UNAVAILABLE" | "INVALID_REQUEST" = "UNAVAILABLE") =>
    new GatewayProtocolRequestError({
      code,
      message: "The live session was lost.",
      details: buildSystemAgentSessionInvalidatedErrorDetails(),
    });

  async function mountReady(request: Parameters<typeof createContext>[0]) {
    const { page } = await mount(request);
    await waitForFast(() => expect(page.textContent).toContain("Ready."));
    return page;
  }

  it.each([false, true])(
    "keeps the live session after a failed ordinary send (sent=%s)",
    async (sent) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce(reply("Ready."))
        .mockImplementationOnce((_method, _params, options?: { onSent?: () => void }) => {
          if (sent) {
            options?.onSent?.();
          }
          return Promise.reject(
            new GatewayProtocolRequestError({
              code: "UNAVAILABLE",
              message: "Temporary request failure.",
            }),
          );
        })
        .mockResolvedValueOnce(reply("Still together."));
      const page = await mountReady(request);
      await send(page, "first try");
      await waitForFast(() => expect(page.textContent).toContain("Temporary request failure."));
      expect(page.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
        sent ? "" : "first try",
      );
      expect(page.store.messages.filter((message) => message.role === "user")).toHaveLength(
        sent ? 1 : 0,
      );
      await send(page, "second try");
      await waitForFast(() => expect(page.textContent).toContain("Still together."));
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[2]?.[1]).toMatchObject({
        sessionId: "engine-session",
        message: "second try",
      });
    },
  );

  it.each(["message", "submit", "cancel"])(
    "clears and masks sensitive input when a %s reply fails",
    async (action) => {
      const pending = createDeferred<never>();
      const value = action === "message" ? ` ${secret} ` : secret;
      const request = vi
        .fn()
        .mockResolvedValueOnce(
          chatReply("Ready.", {
            sessionId: "engine-session",
            sensitive: true,
            ...(action === "message" ? {} : { wizardInputPending: true, step }),
          }),
        )
        .mockImplementationOnce((_method, _params, options?: { onSent?: () => void }) => {
          if (action === "message") {
            options?.onSent?.();
          }
          return pending.promise;
        });
      const page = await mountReady(request);
      const input = await fill(page, password, value);
      const submit = action === "message" ? ".chat-send-btn" : `${wizard} .btn.primary`;
      button(page, action === "cancel" ? ".custodian__wizard-cancel" : submit).click();
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      await page.updateComplete;
      expect(page.querySelector<HTMLInputElement>(password)!.value).toBe("");
      pending.reject(new Error("Temporary request failure."));
      await waitForFast(() => expect(page.textContent).toContain("Temporary request failure."));
      expect(page.querySelector<HTMLInputElement>(password)!.value).toBe("");
      expect(page.innerHTML).not.toContain(secret);
      expect(request).toHaveBeenCalledTimes(2);
      const sent = request.mock.calls[1]?.[1];
      if (action === "message") {
        expect(input.isConnected).toBe(true);
        expect(sent.message).toBe(value);
        expect(page.textContent).toContain("Sensitive reply sent");
      } else if (action === "submit") {
        expect(sent.wizardAnswer.value).toBe(value);
      } else {
        expect(sent).toMatchObject({
          sessionId: "engine-session",
          wizardCancel: { stepId: "credential" },
        });
        expect(sent).not.toHaveProperty("message");
        expect(JSON.stringify(sent)).not.toContain(secret);
      }
    },
  );

  it.each(["submit", "cancel"])(
    "restores ordinary drafts after an invalidated wizard %s",
    async (action) => {
      const { page, request } = await ready(
        { question },
        { ...reply("Enter credential."), sensitive: true, wizardInputPending: true, step },
        invalidated(action === "submit" ? "INVALID_REQUEST" : "UNAVAILABLE"),
        reply("Ready again."),
        reply("Ready again."),
      );
      const draft = "Keep my ordinary question";
      await fill(page, "textarea", draft);
      button(page, ".option-card__choice").click();
      await waitForFast(() => expect(page.querySelector(password)).not.toBeNull());
      expect(page.querySelector<HTMLInputElement>(password)!.value).toBe("");
      expect(request.mock.calls[1]?.[1]?.message).toBe("enter");
      await fill(page, password, secret);
      button(
        page,
        action === "cancel" ? ".custodian__wizard-cancel" : `${wizard} .btn.primary`,
      ).click();
      await waitForFast(() => expect(page.textContent).toContain("Ready again."));
      expectFreshSession(request, 3);
      expect(page.textContent).toContain("Earlier");
      expect(page.textContent).toContain("started a fresh session");
      expect(request.mock.calls[3]?.[1]).not.toHaveProperty("wizardAnswer");
      const restored = page.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(restored.value).toBe(draft);
      expect(page.textContent).not.toContain(secret);
      expect(request.mock.calls.some(([, params]) => params.message === secret)).toBe(false);
      expect(request.mock.calls[3]?.[1]).not.toHaveProperty("wizardCancel");
      restored.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await waitForFast(() => expect(request.mock.calls.at(-1)?.[1]?.message).toBe(draft));
      await page.updateComplete;
      expect(restored.value).toBe("");
    },
  );

  it("stops after one rotation when the fresh session failure is also marked", async () => {
    const { page, request } = await ready({}, invalidated(), invalidated());
    await send(page, "status please");
    await waitForFast(() => expect(page.store.sending).toBe(false));
    expect(page.textContent).toContain("The live session was lost.");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
  });
});
