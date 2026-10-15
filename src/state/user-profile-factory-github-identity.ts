import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { parseFactoryGitHubPrincipal } from "../shared/factory-github-principal.js";
import { normalizeVerifiedEmail } from "../shared/verified-email.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  publishUserProfileAuthorityChange,
  publishUserProfileIdentityChange,
} from "./user-profile-events.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import type { UserProfileMutationContext } from "./user-profile-mutation.js";
import { userProfilesDb } from "./user-profiles-internal.js";
import { UserProfileOwnerError } from "./user-profiles-schema.js";
import type { FactoryGitHubIdentity } from "./user-profiles.types.js";

/** Only current authenticated Factory metadata can establish this host-scoped credit binding. */
export function applyFactoryGitHubIdentity(
  db: EngineConnection,
  params: {
    profileId: string;
    principal: string;
    metadata: { login: string; email?: string };
    mutation?: UserProfileMutationContext;
  },
): void {
  if (params.profileId === GATEWAY_OWNER_PROFILE_ID) {
    throw new UserProfileOwnerError("merge");
  }
  const principal = parseFactoryGitHubPrincipal(params.principal);
  const accountId = principal?.accountId ?? Number.NaN;
  const provider = principal ? `github:${principal.host}` : "";
  const login = normalizeGitHubLogin(params.metadata.login);
  const binding = executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_emails")
      .select(["profile_id", "binding_id"])
      .where("email", "=", params.principal),
  );
  if (
    !Number.isSafeInteger(accountId) ||
    !login ||
    binding?.profile_id !== params.profileId ||
    !binding.binding_id
  ) {
    throw new Error("Factory GitHub identity is invalid");
  }
  const email = normalizeVerifiedEmail(params.metadata.email);
  if (params.metadata.email !== undefined && !email) {
    throw new Error("Factory verified email is invalid");
  }
  // Historical payloads and moved aliases cannot confer credit. Reauthentication writes this binding.
  const proof = JSON.stringify({
    version: 1,
    profileId: params.profileId,
    bindingId: binding.binding_id,
    ...(email ? { email } : {}),
  });
  const kysely = userProfilesDb(db);
  const before = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("user_profile_identities")
      .select(["profile_id", "canonical_login", "verified_email_json"])
      .where("provider", "=", provider)
      .where("subject", "=", String(accountId)),
  );
  if (
    before?.profile_id === params.profileId &&
    before.canonical_login === login &&
    before.verified_email_json === proof
  ) {
    return;
  }
  const changed = [...new Set([params.profileId, ...(before ? [before.profile_id] : [])])];
  params.mutation?.before(db, ...changed);
  const values = {
    profile_id: params.profileId,
    canonical_login: login,
    verified_email_json: proof,
  };
  const now = Date.now();
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("user_profile_identities")
      .values({
        provider,
        subject: String(accountId),
        ...values,
        created_at: now,
      })
      .onConflict((oc) => oc.columns(["provider", "subject"]).doUpdateSet(values)),
  );
  executeSqliteQuerySync(
    db,
    kysely.updateTable("user_profiles").set({ updated_at: now }).where("id", "=", params.profileId),
  );
  params.mutation?.identity(...changed);
  params.mutation?.authority(...changed);
  params.mutation?.publish(...changed);
  publishUserProfileIdentityChange(db, ...changed);
  publishUserProfileAuthorityChange(db, ...changed);
  publishUserProfilesChange(db, ...changed);
}

export function selectFactoryGitHubIdentities(
  db: EngineConnection,
  profileIds?: readonly string[],
  host?: string,
): Map<string, FactoryGitHubIdentity> {
  if (
    profileIds?.length === 0 ||
    !tableHasColumn(db, "user_profile_identities", "verified_email_json")
  ) {
    return new Map();
  }
  let query = userProfilesDb(db)
    .selectFrom("user_profile_identities")
    .select(["provider", "profile_id", "subject", "canonical_login", "verified_email_json"])
    .where("provider", "like", "github:%");
  if (host) {
    query = query.where("provider", "=", `github:${host}`);
  }
  if (profileIds) {
    query = query.where("profile_id", "in", [...profileIds]);
  }
  const rows = executeSqliteQuerySync(db, query).rows;
  if (!rows.length) {
    return new Map();
  }
  const bindings = new Map(
    executeSqliteQuerySync(
      db,
      userProfilesDb(db)
        .selectFrom("user_profile_emails")
        .select(["email", "profile_id", "binding_id"])
        .where(
          "email",
          "in",
          rows.map((row) => `${row.provider}:${row.subject}`),
        ),
    ).rows.map((row) => [row.email, row]),
  );
  const identities = new Map<string, FactoryGitHubIdentity>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    const principal = parseFactoryGitHubPrincipal(`${row.provider}:${row.subject}`);
    const accountId = principal?.accountId ?? Number.NaN;
    const login = row.canonical_login ? normalizeGitHubLogin(row.canonical_login) : undefined;
    let proof: unknown;
    try {
      if (!row.verified_email_json || row.verified_email_json.length > 1024) {
        continue;
      }
      proof = JSON.parse(row.verified_email_json);
    } catch {
      continue;
    }
    if (
      !principal ||
      !isRecord(proof) ||
      proof.version !== 1 ||
      proof.profileId !== row.profile_id ||
      !login ||
      !Number.isSafeInteger(accountId) ||
      accountId <= 0
    ) {
      continue;
    }
    const binding = bindings.get(`${row.provider}:${accountId}`);
    if (binding?.profile_id !== row.profile_id || binding.binding_id !== proof.bindingId) {
      continue;
    }
    const email = normalizeVerifiedEmail(proof.email);
    if (identities.has(row.profile_id)) {
      ambiguous.add(row.profile_id);
    }
    identities.set(row.profile_id, {
      host: principal.host,
      accountId,
      login,
      ...(email ? { verifiedEmail: email } : {}),
    });
  }
  for (const profileId of ambiguous) {
    identities.delete(profileId);
  }
  return identities;
}
