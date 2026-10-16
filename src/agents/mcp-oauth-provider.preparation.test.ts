import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { McpOAuthStore } from "./mcp-oauth-store.js";

const { read, update, context, lease } = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn(),
  lease: {
    signal: new AbortController().signal,
    async assertOwned() {},
    async renew() {},
  },
  context: {
    admission: {
      coordinationKey: "synthetic-state",
      databasePath: "/synthetic/mcp/state.sqlite",
      identity: { key: "synthetic-state", canonicalPath: "/synthetic/mcp/state.sqlite" },
      assertCurrent() {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic/mcp" },
  },
}));

vi.mock("./mcp-oauth-store.js", () => ({
  readMcpOAuthStore: read,
  mutateMcpOAuthStore: update,
}));

import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";

const providerParams = {
  lease,
  storeContext: context,
  identity: {
    principal: "operator",
    storeKey: "synthetic-provider",
    serverName: "synthetic",
    serverUrl: "https://mcp.example.test",
  },
} satisfies Parameters<typeof createMcpOAuthClientProvider>[0];

function loginLifecycle(controller: AbortController) {
  return {
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
    onAuthorizationPublished() {},
    beforeTokensSaved() {},
    onTokensSaved() {},
  };
}

beforeEach(() => {
  read.mockReset();
  update.mockReset();
});

it("rejects tokens when its login lifecycle ends during a credential read", async () => {
  const original = { redirectUrl: "https://callback.example.test/original" };
  read.mockResolvedValueOnce(original);
  const controller = new AbortController();
  const provider = await createMcpOAuthClientProvider({
    ...providerParams,
    allowAuthorizationRedirect: true,
    login: loginLifecycle(controller),
  });
  const delayed = createDeferred<McpOAuthStore>();
  read.mockReturnValueOnce(delayed.promise);
  const result = provider.tokens();
  const failure = new Error("Login lifecycle ended");
  controller.abort(failure);
  delayed.resolve({
    tokens: { access_token: "late-access", token_type: "Bearer" },
    redirectUrl: "https://callback.example.test/late",
  });

  await expect(result).rejects.toBe(failure);
  expect(provider.redirectUrl).toBe(original.redirectUrl);
  expect(provider.clientMetadata.redirect_uris).toEqual([original.redirectUrl]);
});

it.each([
  { operation: "tokens", owner: "login" },
  { operation: "tokens", owner: "lease" },
  { operation: "codeVerifier", owner: "lease" },
] as const)(
  "rejects credential shortcuts after $owner ends ($operation)",
  async ({ operation, owner }) => {
    read.mockResolvedValue({});
    const failure = new Error("credential owner ended");
    const login = new AbortController();
    let leaseLive = true;
    const provider = await createMcpOAuthClientProvider({
      ...providerParams,
      allowAuthorizationRedirect: true,
      suppressStoredTokens: operation === "tokens",
      lease: {
        signal: new AbortController().signal,
        async assertOwned() {
          if (!leaseLive) {
            throw failure;
          }
        },
        async renew() {},
      },
      login: owner === "login" ? loginLifecycle(login) : undefined,
    });
    if (operation === "codeVerifier") {
      await provider.saveCodeVerifier("fixture-prepared-verifier");
    }
    if (owner === "login") {
      login.abort(failure);
    } else {
      leaseLive = false;
    }
    await expect(provider[operation]()).rejects.toBe(failure);
  },
);
