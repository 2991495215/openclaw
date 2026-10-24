import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import type { PluginHookUserFirstSignInEvent } from "../plugins/hook-user-sign-in.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  mergeCanonicalUserProfiles,
} from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  accessOrigin,
  accessRequest,
  githubCfg,
  identityResponse,
  oidcIdentity,
} from "./github-user-identity.oidc.test-support.js";
import { resolveAuthenticatedHttpUserProfile } from "./http-auth-user-profile.js";
import { GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE } from "./operator-access-policy.js";
import {
  noteUserSignIn,
  resetUserFirstSignInDeliveriesForTests,
  resumeUserFirstSignInDeliveries,
  settleUserFirstSignInDeliveriesForTests,
} from "./user-first-sign-in.js";

type Handler = (event: PluginHookUserFirstSignInEvent) => Promise<void> | void;

/** Publishes the Gateway's runtime config and the plugin registry, as startup does. */
function installHandlers(handlers: Record<string, Handler>) {
  setRuntimeConfigSnapshot({});
  const registry = createEmptyPluginRegistry();
  for (const [pluginId, handler] of Object.entries(handlers)) {
    registry.plugins.push(createPluginRecord({ id: pluginId }));
    registry.typedHooks.push({
      pluginId,
      hookName: "user_first_sign_in",
      source: "test",
      handler: (event: PluginHookUserFirstSignInEvent) => handler(event),
    });
  }
  initializeGlobalHookRunner(registry);
  return registry;
}

const previousRegistry = captureActivePluginRegistrySnapshot();

/** Cloudflare Access verifies ada@example.test and her GitHub account 101. */
function mockAccessIdentity() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
    identityResponse(
      url === `${accessOrigin}/cdn-cgi/access/get-identity`
        ? oidcIdentity()
        : { id: 101, login: "canonical-ada", name: "Ada" },
    ),
  );
}

const openRecords = () =>
  createCorePluginStateKeyedStore({
    ownerId: "core:user-sign-in",
    namespace: "first-sign-ins",
    retention: "retained",
  });

/** Drops process-local delivery state, as a Gateway restart would. */
async function simulateRestart() {
  resetUserFirstSignInDeliveriesForTests();
  await closeOpenClawStateDatabaseAsync();
}

async function signIn(profileId: string, method: "trusted-proxy" | "tailscale" = "trusted-proxy") {
  noteUserSignIn({ ok: true, method, user: "person@example.test" }, profileId);
  await settleUserFirstSignInDeliveriesForTests();
}

afterEach(async () => {
  rollbackStagedPluginRegistry(previousRegistry);
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetUserFirstSignInDeliveriesForTests();
  resetGlobalHookRunner();
  await closeOpenClawStateDatabaseAsync();
});

it("fires once for a new profile with its verified identities, across sign-ins and restarts", async () => {
  await withOpenClawTestState({ label: "first-sign-in-once" }, async () => {
    const profile = await ensureCanonicalUserProfileForEmail("Guest@Example.test");
    const events: PluginHookUserFirstSignInEvent[] = [];
    installHandlers({ "visitor-access": (event) => void events.push(event) });

    await signIn(profile.id);
    await signIn(profile.id);
    // The durable marker, not process memory, decides "first".
    await simulateRestart();
    await signIn(profile.id);
    await simulateRestart();
    await resumeUserFirstSignInDeliveries();
    await signIn(profile.id);

    expect(events).toEqual([
      {
        profileId: profile.id,
        displayName: profile.displayName,
        emails: ["guest@example.test"],
        githubAccountIds: [],
        isNewProfile: true,
        profileCreatedAt: profile.createdAt,
        firstSignedInAt: expect.any(Number),
        attempt: 1,
      },
    ]);
  });
});

it("retries a failed handler on restart without redelivering to plugins that succeeded", async () => {
  await withOpenClawTestState({ label: "first-sign-in-restart" }, async () => {
    const profile = await ensureCanonicalUserProfileForEmail("retry@example.test");
    const attempts: { ok: number[]; flaky: number[] } = { ok: [], flaky: [] };
    let flakyFails = true;
    installHandlers({
      ok: (event) => void attempts.ok.push(event.attempt),
      flaky: (event) => {
        attempts.flaky.push(event.attempt);
        if (flakyFails) {
          throw new Error("welcome session unavailable");
        }
      },
    });

    await signIn(profile.id);
    expect(attempts).toEqual({ ok: [1], flaky: [1] });
    // A pending retry owns the next attempt; repeated requests do not hammer the handler.
    await signIn(profile.id);
    expect(attempts.flaky).toEqual([1]);

    // The process stops before its retry timer fires.
    await simulateRestart();
    flakyFails = false;
    await resumeUserFirstSignInDeliveries();
    await signIn(profile.id);

    expect(attempts).toEqual({ ok: [1], flaky: [1, 2] });
  });
});

it("retries a failed handler in-process after backoff", async () => {
  await withOpenClawTestState({ label: "first-sign-in-backoff" }, async () => {
    const profile = await ensureCanonicalUserProfileForEmail("backoff@example.test");
    const attempts: number[] = [];
    installHandlers({
      flaky: (event) => {
        attempts.push(event.attempt);
        if (event.attempt === 1) {
          throw new Error("transient");
        }
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });

    await signIn(profile.id);
    expect(attempts).toEqual([1]);
    await vi.advanceTimersByTimeAsync(5_000);
    await settleUserFirstSignInDeliveriesForTests();

    expect(attempts).toEqual([1, 2]);
  });
});

it("never waits for or fails on the handler", async () => {
  await withOpenClawTestState({ label: "first-sign-in-detached" }, async () => {
    const profile = await ensureCanonicalUserProfileForEmail("slow@example.test");
    let release!: () => void;
    const started = vi.fn();
    installHandlers({
      slow: () => {
        started();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    expect(
      noteUserSignIn({ ok: true, method: "trusted-proxy", user: "slow@example.test" }, profile.id),
    ).toBeUndefined();
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    release();
    await settleUserFirstSignInDeliveriesForTests();
  });
});

it("reports existing profiles once as not new, and skips plugins registered later", async () => {
  await withOpenClawTestState({ label: "first-sign-in-existing" }, async () => {
    const profile = await ensureCanonicalUserProfileForEmail("member@example.test");
    const early: PluginHookUserFirstSignInEvent[] = [];
    installHandlers({ early: (event) => void early.push(event) });
    vi.spyOn(Date, "now").mockReturnValue(profile.createdAt + 10 * 60_000);
    await signIn(profile.id);
    vi.mocked(Date.now).mockRestore();

    const late = vi.fn();
    installHandlers({ early: (event) => void early.push(event), late });
    await simulateRestart();
    await resumeUserFirstSignInDeliveries();
    await signIn(profile.id);

    expect(early).toEqual([
      expect.objectContaining({ profileId: profile.id, isNewProfile: false }),
    ]);
    expect(late).not.toHaveBeenCalled();
    const [record] = await openRecords().entries();
    expect(record).toMatchObject({ key: profile.id, value: { pendingPluginIds: [] } });
  });
});

it("keeps a merged-in profile's first sign-in and pending delivery with the merge target", async () => {
  await withOpenClawTestState({ label: "first-sign-in-merge" }, async () => {
    const source = await ensureCanonicalUserProfileForEmail("old-login@example.test");
    const target = await ensureCanonicalUserProfileForEmail("new-login@example.test");
    const events: PluginHookUserFirstSignInEvent[] = [];
    installHandlers({
      welcome: (event) => {
        events.push(event);
        if (event.attempt === 1) {
          throw new Error("welcome session unavailable");
        }
      },
    });

    await signIn(source.id);
    await mergeCanonicalUserProfiles(source.id, target.id);
    await signIn(target.id);
    await simulateRestart();
    await resumeUserFirstSignInDeliveries();

    expect(events.map(({ profileId, attempt }) => ({ profileId, attempt }))).toEqual([
      { profileId: source.id, attempt: 1 },
      { profileId: target.id, attempt: 2 },
    ]);
  });
});

it("delivers a Cloudflare Access sign-in with its verified GitHub account after admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    mockAccessIdentity();
    const events: PluginHookUserFirstSignInEvent[] = [];
    installHandlers({ "visitor-access": (event) => void events.push(event) });
    const request = accessRequest("ada@example.test", githubCfg);
    try {
      const http = await resolveAuthenticatedHttpUserProfile(request);
      // Sign-in completed before delivery; the handler runs detached.
      await settleUserFirstSignInDeliveriesForTests();
      await resolveAuthenticatedHttpUserProfile(request);
      await settleUserFirstSignInDeliveriesForTests();

      expect(events).toEqual([
        expect.objectContaining({
          profileId: http.authenticatedUserProfile?.profileId,
          displayName: "Ada",
          emails: ["ada@example.test"],
          githubAccountIds: [101],
          isNewProfile: true,
          attempt: 1,
        }),
      ]);
    } finally {
      request.req.destroy();
    }
  });
});

it("does not fire for shared-secret operators or people denied by an access policy", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    mockAccessIdentity();
    const handler = vi.fn();
    const registry = installHandlers({ "visitor-access": handler });
    registry.gatewayAccessPolicies.push({
      pluginId: "visitor-access",
      source: "test",
      policy: { authorize: () => undefined },
    });
    stageActivePluginRegistry(registry, null, "default");
    const deniedCfg = {
      gateway: {
        ...githubCfg.gateway,
        roles: {
          default: "visitor",
          definitions: {
            visitor: {
              sessions: { others: "none" },
              agents: [],
              scopes: [],
              accessPolicyPlugin: "visitor-access",
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    // The Gateway keeps its profile catalog resident for access-policy checks.
    const catalog = await prepareUserProfileCatalog();
    const denied = accessRequest("ada@example.test", deniedCfg);
    try {
      await expect(resolveAuthenticatedHttpUserProfile(denied)).rejects.toThrow(
        GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE,
      );
    } finally {
      denied.req.destroy();
      catalog.release();
    }
    const operator = accessRequest("ignored@example.test", {});
    try {
      await resolveAuthenticatedHttpUserProfile({
        ...operator,
        authResult: { ok: true, method: "token" },
      });
      await settleUserFirstSignInDeliveriesForTests();

      expect(handler).not.toHaveBeenCalled();
      expect(await openRecords().entries()).toEqual([]);
    } finally {
      operator.req.destroy();
    }
  });
});

it("records nothing for unverified identities, then fires for a verified sign-in", async () => {
  await withOpenClawTestState({ label: "first-sign-in-verified" }, async () => {
    const profile = await ensureCanonicalUserProfileForEmail("unverified@example.test");
    const handler = vi.fn();
    installHandlers({ welcome: handler });
    for (const auth of [
      { ok: false, method: "trusted-proxy", user: "unverified@example.test" },
      { ok: true, method: "trusted-proxy", user: " " },
      { ok: true, method: "token", user: "unverified@example.test" },
      { ok: true, method: "password" },
      { ok: true, method: "device-token" },
      { ok: true, method: "remote-ingress" },
      { ok: true, method: "none" },
    ] as const) {
      noteUserSignIn(auth, profile.id);
    }
    await settleUserFirstSignInDeliveriesForTests();
    expect(handler).not.toHaveBeenCalled();
    expect(await openRecords().entries()).toEqual([]);

    await signIn(profile.id, "tailscale");
    expect(handler).toHaveBeenCalledOnce();
  });
});
