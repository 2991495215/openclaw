import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  GIT_COAUTHOR_PREFERENCE_KEY,
  validateUsersSelfResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  prepareGitCoauthorAttribution,
  resolveGitCoauthorAttribution,
} from "../agents/git-coauthor-attribution.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";
import { getUserPreferences, setUserPreferences } from "../state/user-preferences.test-support.js";
import { getUserProfileListItem } from "../state/user-profile-list-item.test-support.js";
import { linkEmail, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGitHubPublicationContent } from "./github-publication-content.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import { createControlUiRequestOptions } from "./server-methods/control-ui-request.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type { RespondFn } from "./server-methods/types.js";
import { usersHandlers } from "./server-methods/users.js";

function factorySync(email?: string, host = "ghe.example.test") {
  return expectDefined(
    createAuthenticatedGitHubIdentitySync({
      authResult: { ok: true, method: "trusted-proxy", user: `github:${host}:101` },
      config: { gateway: { github: { host } } },
      authConfig: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
      requestHeaders: {
        "x-factory-github-login": "enterprise-ada",
        "x-factory-github-name": "Ada",
        ...(email ? { "x-factory-github-email": email } : {}),
      },
    }),
    "Factory identity sync",
  );
}

afterEach(() => vi.restoreAllMocks());

it.each(["ghe.example.test", "code.example.test"])(
  "carries configured %s identity through users.self and opted-in credit without public-ID collisions",
  async (host) => {
    const principal = `github:${host}:101`;
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async (state) => {
        await captureRuntimeConfigAsyncReader()();
        const transport = vi
          .spyOn(globalThis, "fetch")
          .mockRejectedValue(new Error("No external lookup allowed"));
        const publicProfile = syncGitHubIdentity({
          identity: { accountId: 101, login: "public-ada" },
          authenticationAlias: { kind: "email", email: "public@example.test" },
        });
        const profile = ensureProfileForEmail(principal);
        setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true });
        const sync = factorySync("ada@enterprise.example", host);
        expect((await sync()).profileId).toBe(profile.id);
        const client = {
          ...identifiedClient(profile.id),
          connId: "factory-credit",
          authenticatedGitHubIdentitySync: sync,
        };
        const respond = vi.fn<RespondFn>();
        const request = createControlUiRequestOptions(() => ({}))({}, respond, { client });
        await expectDefined(
          usersHandlers["users.self"],
          "users.self handler",
        )({ ...request, client });
        expect(respond).toHaveBeenCalledWith(true, {
          profile: expect.objectContaining({
            id: profile.id,
            emails: [principal],
            githubIdentity: {
              host,
              login: "enterprise-ada",
              profileUrl: `https://${host}/enterprise-ada`,
              avatarUrl: `https://${host}/avatars/u/101`,
            },
          }),
        });
        expect(validateUsersSelfResult(respond.mock.calls[0]?.[1])).toBe(true);
        expect((await prepareUserProfileRoleAuthority(profile.id))?.githubLogin).toBeNull();
        expect(getUserProfileListItem(publicProfile.id).githubIdentity?.login).toBe("public-ada");
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:factory-credit" };
        await upsertSessionEntryCore(scope, { sessionId: "factory-credit", updatedAt: 1 });
        for (const id of [profile.id, publicProfile.id]) {
          recordSessionParticipant(scope, {
            identity: { type: "profile", id },
            promptedAt: 1,
            sessionAgentId: "main",
          });
        }
        const params = { ...scope, config: { gateway: { github: { host } } } };
        const prepared = await prepareGitCoauthorAttribution(params);
        expect(prepared.attribution).toEqual({
          logins: ["enterprise-ada"],
          trailers: ["Co-authored-by: enterprise-ada <ada@enterprise.example>"],
        });
        expect(await resolveGitCoauthorAttribution({ ...scope, config: {} })).toEqual({
          logins: ["public-ada"],
          trailers: ["Co-authored-by: public-ada <101+public-ada@users.noreply.github.com>"],
        });
        const publication = {
          row: {
            request_id: "enterprise-credit",
            agent_id: "main",
            session_id: "factory-credit",
            session_key: scope.sessionKey,
            branch: "work",
            title: "Prepared change",
          },
          storePath: resolveSessionStorePathForScope(scope, {}),
          accountId: 999,
          assertCurrent: () => {},
          description: "Synthetic publication",
        };
        const content = await prepareGitHubPublicationContent({
          ...publication,
          host,
        });
        expect(content.trailers).toEqual([
          "Co-authored-by: enterprise-ada <ada@enterprise.example>",
        ]);
        expect(content.commitMessage).not.toContain("public-ada");
        const publicContent = await prepareGitHubPublicationContent({
          ...publication,
          host: "github.com",
        });
        expect(publicContent.trailers).toEqual([
          "Co-authored-by: public-ada <101+public-ada@users.noreply.github.com>",
        ]);
        setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
        expect(prepared.isCurrent()).toBe(false);
        expect(() => content.assertAction()).toThrow("contributor credit changed");
        expect(await resolveGitCoauthorAttribution(params)).toBeUndefined();
        await factorySync("ada@enterprise.example", host)();
        expect(getUserPreferences(profile.id, [GIT_COAUTHOR_PREFERENCE_KEY])).toEqual({
          [GIT_COAUTHOR_PREFERENCE_KEY]: false,
        });
        setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true });
        await factorySync(undefined, host)();
        expect(getUserProfileListItem(profile.id).githubIdentity?.login).toBe("enterprise-ada");
        expect(await resolveGitCoauthorAttribution(params)).toBeUndefined();
        expect(getUserPreferences(profile.id, [GIT_COAUTHOR_PREFERENCE_KEY])).toEqual({
          [GIT_COAUTHOR_PREFERENCE_KEY]: true,
        });
        expect(transport).not.toHaveBeenCalled();
      },
    );
  },
);

it("requires fresh sign-in after historical evidence or a principal alias move without importing preferences or email aliases", async () => {
  const principal = "github:ghe.example.test:101";
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const profile = ensureProfileForEmail(principal);
    const { db } = openOpenClawStateDatabase();
    linkEmail("anchor@example.test", profile.id);
    db.prepare(
      "INSERT INTO user_profile_identities(provider,subject,profile_id,canonical_login,verified_email_json,created_at) VALUES(?,?,?,?,?,1)",
    ).run(
      "github:ghe.example.test",
      "101",
      profile.id,
      "historical",
      JSON.stringify({ email: "old@example.test", profileId: profile.id }),
    );
    expect(getUserProfileListItem(profile.id).githubIdentity).toBeNull();
    await factorySync("ada@enterprise.example")();
    expect(getUserProfileListItem(profile.id).githubIdentity?.login).toBe("enterprise-ada");
    const other = ensureProfileForEmail("other@example.test");
    linkEmail(principal, other.id);
    expect(getUserProfileListItem(other.id).githubIdentity).toBeNull();
    linkEmail(principal, profile.id);
    expect(getUserProfileListItem(profile.id).githubIdentity).toBeNull();
    await factorySync("ada@enterprise.example")();
    expect(getUserProfileListItem(profile.id).githubIdentity?.login).toBe("enterprise-ada");
    expect(getUserProfileListItem(profile.id).emails).not.toContain("ada@enterprise.example");
    expect(getUserPreferences(profile.id, [GIT_COAUTHOR_PREFERENCE_KEY])).toEqual({});
  });
});
