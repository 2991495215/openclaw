import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import timersPromises from "node:timers/promises";
import { promisify } from "node:util";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const automation = {
  id: "qa-monitor",
  agentId: "qa",
  payload: { kind: "agentTurn" },
  sessionTarget: "isolated",
  enabled: true,
};
const idleSession = { key: "agent:qa:main", hasActiveRun: false };
const contextReply = {
  to: "dm:qa-heartbeat-live-contract",
  text: "QA-AUTOMATION-CONTEXT-READY",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(timersPromises, "setTimeout").mockImplementation(promisify(setTimeout));
  syncBuiltinESMExports();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  syncBuiltinESMExports();
});

async function runStartup(
  options: {
    listSessions?: () => readonly { key: string; hasActiveRun?: boolean }[];
    createdAutomation?: unknown;
    reply?: typeof contextReply | null;
  } = {},
) {
  const scenario = readQaScenarioById("heartbeat-shared-runtime-live-contract");
  const step = scenario.execution.flow?.steps[0];
  assert.ok(step);
  const phaseIndex = step.actions.findIndex((action) => isRecord(action) && "forEach" in action);
  assert.ok(phaseIndex > 0);
  const state = createQaBusState();
  const call = vi.fn(async (method: string, _params: unknown) => {
    if (method === "sessions.list") {
      return { sessions: options.listSessions?.() ?? [idleSession] };
    }
    assert.equal(method, "cron.add");
    return options.createdAutomation ?? automation;
  });
  const pending = runLoadedScenarioFlow(scenario.id, {
    // Exercise the shipped setup; model-driven automation phases stay in the live lane.
    flow: {
      steps: [
        {
          name: step.name,
          actions: step.actions.slice(0, phaseIndex),
          detailsExpr: "JSON.stringify(monitor)",
        },
      ],
    },
    state,
    onWaitForOutboundMessage: () => {
      const reply = options.reply === undefined ? contextReply : options.reply;
      if (reply) {
        state.addOutboundMessage({ accountId: "qa-channel", ...reply });
      }
    },
    api: {
      env: { providerMode: "live-frontier", gateway: { call } },
      waitForCondition: waitForQaTransportCondition,
    },
  }).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
  await vi.runAllTimersAsync();
  return { ...(await pending), call, state };
}

describe("automation scenario context setup", () => {
  it.each([0, 700, 119_900])(
    "creates an isolated automation after its main session becomes idle at %i ms",
    async (delayMs) => {
      const { result, error, call, state } = await runStartup({
        listSessions: () => [{ ...idleSession, hasActiveRun: Date.now() < delayMs }],
      });
      expect(error).toBeUndefined();
      expect(result?.status).toBe("pass");
      expect(result?.steps[0]?.details).toBe(JSON.stringify(automation));
      expect(Date.now()).toBe(delayMs);
      expect(state.getSnapshot().messages[0]).toMatchObject({
        direction: "inbound",
        conversation: { id: "qa-heartbeat-live-contract", kind: "direct" },
        text: "Reply exactly: QA-AUTOMATION-CONTEXT-READY",
      });
      expect(call.mock.calls.filter(([method]) => method === "cron.add")).toEqual([
        [
          "cron.add",
          expect.objectContaining({
            agentId: "qa",
            sessionTarget: "isolated",
            sessionKey: "agent:qa:main",
            payload: expect.objectContaining({
              kind: "agentTurn",
              skipIfScratchEmpty: true,
              toolsAllow: ["automations"],
            }),
            delivery: {
              mode: "announce",
              channel: "qa-channel",
              to: "dm:qa-heartbeat-live-contract",
              directPolicy: "allow",
            },
          }),
        ],
      ]);
    },
  );

  it.each([
    ["absent", []],
    ["another session idle", [{ ...idleSession, key: "agent:other:main" }]],
    ["still active", [{ ...idleSession, hasActiveRun: true }]],
  ] as const)(
    "does not create an automation when the main session is %s",
    async (_label, sessions) => {
      const { result, error, call } = await runStartup({ listSessions: () => sessions });
      expect(result).toBeUndefined();
      expect(String(error)).toContain("timed out after 120000ms");
      expect(Date.now()).toBe(120_000);
      expect(call.mock.calls.every(([method]) => method === "sessions.list")).toBe(true);
    },
  );

  it.each([
    ["missing", null],
    ["in another conversation", { ...contextReply, to: "dm:other" }],
    ["the wrong marker", { ...contextReply, text: "not the context acknowledgment" }],
  ] as const)("requires the context reply when it is %s", async (_label, reply) => {
    const { result, error, call } = await runStartup({ reply });
    expect(result).toBeUndefined();
    expect(String(error)).toContain("waiting for outbound marker");
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["missing identity", { ...automation, id: "" }],
    ["disabled", { ...automation, enabled: false }],
    ["a legacy heartbeat", { ...automation, payload: { kind: "heartbeat" } }],
    ["in the main session", { ...automation, sessionTarget: "main" }],
  ] as const)("rejects a created automation that is %s", async (_label, createdAutomation) => {
    const { result, error } = await runStartup({ createdAutomation });
    expect(result).toBeUndefined();
    expect(String(error)).toContain("Expected an ordinary isolated automation.");
  });
});
