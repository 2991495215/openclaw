import {
  createNativeSessionBindingAuthority,
  prepareNativeSessionGenerationAuthority,
} from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore,
} from "./app-server/auth-profile.js";
import { requestCodexAppServerJson } from "./app-server/request.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import { handleCodexAuthProfileMigration } from "./auth-profile-migration-runtime.js";
import { registerCodexAuthProfileMigration } from "./auth-profile-migration.js";

vi.mock("openclaw/plugin-sdk/agent-harness-session-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-session-runtime")>()),
  prepareNativeSessionGenerationAuthority: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  patchSessionEntry: vi.fn(),
  resolveStorePath: () => "/isolated/session-store",
}));
vi.mock("./app-server/auth-profile.js", () => ({
  resolveCodexAppServerAuthProfileIdForAgent: vi.fn(),
  resolveCodexAppServerAuthProfileStore: vi.fn(),
}));
vi.mock("./app-server/config.js", () => ({
  resolveCodexAppServerRuntimeOptions: () => ({
    start: { transport: "websocket", url: "wss://owner.example.test" },
  }),
}));
vi.mock("./app-server/request.js", () => ({ requestCodexAppServerJson: vi.fn() }));

const params = {
  agentId: "main",
  sessionKey: "agent:main:test",
  expectedSessionId: "session-1",
  expectedThreadId: "thread-1",
  expectedClientId: "client-1",
  expectedAuthProfileId: "openai:retired",
  expectedAccountEmail: "owner@example.test",
  expectedServerUrl: "wss://owner.example.test",
};
type Entry = Parameters<Parameters<typeof patchSessionEntry>[0]["update"]>[0];

describe("codex.migrateAuthProfile", () => {
  let config: OpenClawConfig;
  let entry: Entry;
  let current: boolean;
  const mutate = vi.fn<CodexAppServerBindingStore["mutate"]>();

  it("registers only an administrator-scoped operation", () => {
    const registerGatewayMethod = vi.fn();
    registerCodexAuthProfileMigration({ registerGatewayMethod }, { mutate });
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "codex.migrateAuthProfile",
      expect.any(Function),
      { scope: "operator.admin" },
    );
  });

  beforeEach(() => {
    vi.resetAllMocks();
    config = { agents: { entries: { main: {} } } };
    current = true;
    entry = {
      sessionId: "session-1",
      updatedAt: 123,
      authProfileOverride: "openai:retired",
      authProfileOverrideSource: "auto",
      status: "done",
    };
    mutate.mockResolvedValue(true);
    vi.mocked(resolveCodexAppServerAuthProfileStore).mockReturnValue({ version: 1, profiles: {} });
    vi.mocked(prepareNativeSessionGenerationAuthority).mockResolvedValue({
      state: "current",
      previousSessionId: undefined,
      authority: createNativeSessionBindingAuthority([], () => {}),
    });
    vi.mocked(requestCodexAppServerJson).mockResolvedValue({
      account: { type: "chatgpt", email: "owner@example.test", planType: "test" },
      requiresOpenaiAuth: true,
    });
    vi.mocked(patchSessionEntry).mockImplementation(async (options) => {
      options.assertCommitAllowed?.();
      const patch = await options.update(entry, { existingEntry: entry });
      if (!patch) {
        return null;
      }
      options.assertCommitAllowed?.();
      entry = { ...entry, ...patch };
      return entry;
    });
  });

  async function request(overrides: Record<string, unknown> = {}) {
    const payload = { ...params, ...overrides };
    const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
    await handleCodexAuthProfileMigration(
      {
        req: {
          type: "req",
          id: "migration-test",
          method: "codex.migrateAuthProfile",
          params: payload,
        },
        params: payload,
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: { getRuntimeConfig: () => config } as GatewayRequestHandlerOptions["context"],
        hasCurrentClientAuthority: () => current,
      },
      { mutate },
    );
    return respond;
  }

  it("dry-runs against the native endpoint without clearing either pin", async () => {
    const before = structuredClone(entry);
    const respond = await request();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ applied: false, nativeAccountVerified: true }),
    );
    expect(entry).toEqual(before);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[1]).toMatchObject({ dryRun: true });
    expect(requestCodexAppServerJson).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "account/read",
        authProfileId: null,
        requestParams: { refreshToken: false },
      }),
    );
  });

  it("clears the outer producer before binding CAS and preserves session identity and activity", async () => {
    mutate.mockImplementation(async (_identity, mutation) => {
      if (mutation.kind === "clear-auth-profile" && !mutation.dryRun) {
        expect(entry.authProfileOverride).toBeUndefined();
      }
      return true;
    });
    const respond = await request({ apply: true, confirmNativeAccount: true });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ applied: true, outerProfileCleared: true, threadId: "thread-1" }),
    );
    expect(entry).toMatchObject({ sessionId: "session-1", updatedAt: 123, status: "done" });
    expect(entry.authProfileOverride).toBeUndefined();
    expect(entry.authProfileOverrideSource).toBeUndefined();
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it.each(["owner", "endpoint", "confirmation", "profile", "authority"])(
    "refuses invalid %s before any state mutation",
    async (failure) => {
      const overrides: Record<string, unknown> = { apply: true, confirmNativeAccount: true };
      if (failure === "owner") {
        overrides.expectedAccountEmail = "other@example.test";
      }
      if (failure === "endpoint") {
        overrides.expectedServerUrl = "wss://other.example.test";
      }
      if (failure === "confirmation") {
        overrides.confirmNativeAccount = false;
      }
      if (failure === "profile") {
        vi.mocked(resolveCodexAppServerAuthProfileIdForAgent).mockReturnValue("openai:other");
      }
      if (failure === "authority") {
        current = false;
      }
      const respond = await request(overrides);
      expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(patchSessionEntry).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it.each(["generation", "running", "new-profile"])(
    "preserves changed outer %s state",
    async (failure) => {
      if (failure === "generation") {
        entry.sessionId = "session-2";
      }
      if (failure === "running") {
        entry.status = "running";
      }
      if (failure === "new-profile") {
        entry.authProfileOverride = "openai:new";
      }
      const before = structuredClone(entry);
      const respond = await request({ apply: true, confirmNativeAccount: true });
      expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(entry).toEqual(before);
      expect(mutate).toHaveBeenCalledTimes(1);
    },
  );
});
