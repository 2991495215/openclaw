import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing } from "../../../acp/control-plane/manager.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type ConversationRef,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { buildCommandTestParams } from "../commands.test-harness.js";
import { handleAcpResetOptionsAction, handleAcpStatusAction } from "./runtime-options.js";
import { resolveAcpTargetSessionKey } from "./targets.js";

const gatewayRequest = vi.hoisted(() => vi.fn());
vi.mock("../../../agents/tools/in-process-gateway.js", () => ({
  bindAgentToolGatewayRequest: () => gatewayRequest,
}));

const cfg = {
  agents: { ownership: "explicit", entries: { main: {}, work: {}, other: {} } },
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;
const boundSessionKey = "agent:work:acp:bound";
const binding: SessionBindingRecord = {
  bindingId: "target-owner-binding",
  targetKind: "session",
  targetSessionKey: boundSessionKey,
  status: "active",
  boundAt: 1,
  conversation: { channel: "webchat", accountId: "default", conversationId: "room" },
};
function resolveBinding(ref: ConversationRef): SessionBindingRecord | null {
  return ref.channel === binding.conversation.channel &&
    ref.accountId === binding.conversation.accountId &&
    ref.conversationId === binding.conversation.conversationId
    ? binding
    : null;
}
const adapter: SessionBindingAdapter = {
  channel: "webchat",
  accountId: "default",
  listBySession: (key) => (key === boundSessionKey ? [binding] : []),
  resolveByConversation: resolveBinding,
  resolveByConversationAsync: async (ref) => resolveBinding(ref),
};
beforeEach(() => {
  gatewayRequest.mockReset();
  registerSessionBindingAdapter(adapter);
});
afterEach(() => {
  unregisterSessionBindingAdapter({ channel: "webchat", accountId: "default", adapter });
});

function createParams(body = "/acp status") {
  return buildCommandTestParams(body, cfg, {
    Provider: "webchat",
    Surface: "webchat",
    OriginatingChannel: "webchat",
    OriginatingTo: "room",
    AccountId: "default",
    CommandSource: "native",
    CommandTargetSessionKey: "agent:main:main",
  });
}

it("prefers the conversation binding over the native command context", async () => {
  await expect(resolveAcpTargetSessionKey({ commandParams: createParams() })).resolves.toEqual({
    ok: true,
    agentId: "work",
    sessionKey: boundSessionKey,
  });
  expect(gatewayRequest).not.toHaveBeenCalled();
});

it("prefers an explicit ACP argument over the binding and native chat target", async () => {
  const explicitSessionKey = "agent:other:acp:selected";
  gatewayRequest.mockResolvedValue({ key: explicitSessionKey, agentId: "other" });
  await expect(
    resolveAcpTargetSessionKey({
      commandParams: createParams(`/acp status ${explicitSessionKey}`),
      token: explicitSessionKey,
    }),
  ).resolves.toEqual({ ok: true, agentId: "other", sessionKey: explicitSessionKey });
  expect(gatewayRequest).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: "sessions.resolve",
      params: expect.objectContaining({
        key: explicitSessionKey,
        allowMissing: true,
        agentId: "other",
      }),
    }),
  );
});

describe("optional-target runtime actions", () => {
  const getStatus = vi.fn();
  const resetOptions = vi.fn();
  beforeEach(() => {
    getStatus.mockReset();
    resetOptions.mockReset().mockResolvedValue({});
    testing.setAcpSessionManagerForTests({
      getSessionStatus: getStatus,
      resetSessionRuntimeOptions: resetOptions,
    });
  });
  afterEach(() => testing.resetAcpSessionManagerForTests());

  describe.each([
    {
      action: "status",
      handle: handleAcpStatusAction,
      effect: getStatus,
      fallback: "Could not read ACP session status.",
    },
    {
      action: "reset-options",
      handle: handleAcpResetOptionsAction,
      effect: resetOptions,
      fallback: "Could not reset ACP runtime options.",
    },
  ])("$action", ({ action, handle, effect, fallback }) => {
    it("rejects extra targets before backend work", async () => {
      const result = await handle(createParams(), ["first", "second"]);

      expect(result?.reply?.text).toBe(
        `⚠️ Usage: /acp ${action} [session-key|session-id|session-label]`,
      );
      expect(effect).not.toHaveBeenCalled();
      expect(gatewayRequest).not.toHaveBeenCalled();
    });

    it("preserves the backend failure reply", async () => {
      effect.mockRejectedValueOnce("backend failure");

      const result = await handle(createParams(), []);

      expect(result?.reply?.text).toBe(
        `ACP error (ACP_TURN_FAILED): ${fallback}\nnext: Retry, or use \`/acp cancel\` and send the message again.`,
      );
    });

    it("propagates target-resolution cancellation without a backend fallback", async () => {
      const reason = new Error("command cancelled");
      const params = createParams();
      params.opts = { ...params.opts, abortSignal: AbortSignal.abort(reason) };

      await expect(handle(params, [])).rejects.toBe(reason);
      expect(effect).not.toHaveBeenCalled();
    });
  });

  it("resets the bound session's runtime options", async () => {
    const params = createParams();
    const assertCurrent = () => {};
    params.command.assertOwnerCurrent = assertCurrent;
    const result = await handleAcpResetOptionsAction(params, []);

    expect(result?.reply?.text).toBe(`✅ Reset ACP runtime options for ${boundSessionKey}.`);
    expect(resetOptions).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cfg,
        sessionKey: boundSessionKey,
        agentId: "work",
        assertActive: assertCurrent,
      }),
    );
  });
});
