import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { getRuntimeConfig } from "../config/io.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { getGlobalPluginRegistry } from "../plugins/hook-runner-global.js";
import { withHookTimeout } from "../plugins/hook-timeout.js";
import type { PluginHookRegistration } from "../plugins/hook-types.js";
import type {
  PluginHookUserFirstSignInContext,
  PluginHookUserFirstSignInEvent,
} from "../plugins/hook-user-sign-in.types.js";
import { runWithGatewayDetachedWorkAdmission } from "../process/gateway-work-admission.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import {
  captureResidentUserProfileAccess,
  prepareUserProfileCatalog,
  prepareUserProfileIdentity,
} from "../state/user-profile-list.js";
import { UserProfileNotFoundError } from "../state/user-profiles-schema.js";
import type { GatewayAuthResult } from "./auth.js";
import { formatForLog } from "./ws-log.js";

const log = createSubsystemLogger("gateway/user-sign-in");
const NEW_PROFILE_WINDOW_MS = 60_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60 * 60_000;
// Detached from sign-in; a timeout counts as a failed attempt and is retried later.
const HANDLER_TIMEOUT_MS = 60_000;

/** One row per profile that ever signed in; the row itself is the durable "first" marker. */
type FirstSignInRecord = {
  firstSignedInAt: number;
  /** Plugins that had handlers at first sign-in and have not completed one yet. */
  pendingPluginIds: string[];
  /** Failed attempts per pending plugin. */
  attempts: Record<string, number>;
};

const openRecords = () =>
  createCorePluginStateKeyedStore<FirstSignInRecord>({
    ownerId: "core:user-sign-in",
    namespace: "first-sign-ins",
    retention: "retained",
  });

// Process-local caches. Profiles without pending deliveries skip the store on later
// sign-ins; a restart only costs one lookup per person.
const settled = new Set<string>();
const running = new Map<string, Promise<void>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Consecutive deliveries that failed before reaching handlers (storage, profile catalog).
const deferrals = new Map<string, number>();

function firstSignInHooks(): PluginHookRegistration<"user_first_sign_in">[] {
  return (getGlobalPluginRegistry()?.typedHooks ?? []).filter(
    (hook): hook is PluginHookRegistration<"user_first_sign_in"> =>
      hook.hookName === "user_first_sign_in",
  );
}

/** Runs one plugin's handlers in priority order; rejects so its delivery stays pending. */
async function runPluginHandlers(
  pluginId: string,
  event: PluginHookUserFirstSignInEvent,
  ctx: PluginHookUserFirstSignInContext,
): Promise<void> {
  const hooks = firstSignInHooks()
    .filter((hook) => hook.pluginId === pluginId)
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const hook of hooks) {
    await withHookTimeout(
      Promise.resolve().then(() => hook.handler(event, ctx)),
      hook.timeoutMs ?? HANDLER_TIMEOUT_MS,
      { unref: true },
    );
  }
}

/**
 * Record an admitted sign-in after its profile is durable. Only identity-provider-verified
 * people count; shared secrets, devices, and the owner profile never do. Never waits or
 * throws: delivery is detached from sign-in and retried on failure, on the person's next
 * sign-in, and on the next Gateway start.
 */
export function noteUserSignIn(
  auth: Pick<GatewayAuthResult, "ok" | "method" | "user">,
  profileId: string,
): void {
  const verified =
    auth.ok &&
    Boolean(auth.user?.trim()) &&
    (auth.method === "trusted-proxy" || auth.method === "tailscale");
  // Without a handler nothing is recorded, so Gateways without consumers do no work.
  // A scheduled retry owns the next attempt; repeated requests must not hammer a failing handler.
  if (
    verified &&
    firstSignInHooks().length > 0 &&
    profileId !== GATEWAY_OWNER_PROFILE_ID &&
    !settled.has(profileId) &&
    !retryTimers.has(profileId)
  ) {
    void runDelivery(profileId);
  }
}

/** Retry deliveries a previous process recorded but did not finish. */
export async function resumeUserFirstSignInDeliveries(): Promise<void> {
  // Rows wait for a start with handlers; a Gateway without consumers does not read the store.
  if (firstSignInHooks().length === 0) {
    return;
  }
  for (const { key, value } of await openRecords().entries()) {
    if (value.pendingPluginIds.length === 0) {
      settled.add(key);
    } else {
      await runDelivery(key);
    }
  }
}

function runDelivery(profileId: string): Promise<void> {
  const existing = running.get(profileId);
  if (existing) {
    return existing;
  }
  const work = runInDetachedAsyncContext(() =>
    runWithGatewayDetachedWorkAdmission(() => deliver(profileId), "user-first-sign-in"),
  )
    .then(
      () => {
        deferrals.delete(profileId);
      },
      (error: unknown) => {
        // Recorded rows stay pending for a backoff retry, the next sign-in, or Gateway start.
        const attempt = (deferrals.get(profileId) ?? 0) + 1;
        deferrals.set(profileId, attempt);
        scheduleRetry(profileId, attempt);
        log.warn(`first sign-in delivery deferred profile=${profileId}: ${formatForLog(error)}`);
      },
    )
    .finally(() => {
      running.delete(profileId);
    });
  running.set(profileId, work);
  return work;
}

async function deliver(profileId: string): Promise<void> {
  const store = openRecords();
  let record = await store.lookup(profileId);
  if (!record) {
    // A merged-in profile's sign-in is this person's history; the merge target inherits it.
    const merged = await findMergedRecord(profileId);
    const created: FirstSignInRecord = merged?.record ?? {
      firstSignedInAt: Date.now(),
      // Plugins that register later do not receive earlier people's first sign-in.
      pendingPluginIds: [...new Set(firstSignInHooks().map((hook) => hook.pluginId))],
      attempts: {},
    };
    const registered = await store.registerIfAbsent(profileId, created);
    if (registered && merged?.record.pendingPluginIds.length) {
      // The target now owns the pending deliveries; a crash before this only duplicates one.
      await store.register(merged.key, { ...merged.record, pendingPluginIds: [], attempts: {} });
    }
    record = registered ? created : await store.lookup(profileId);
    if (!record) {
      return;
    }
  }
  if (record.pendingPluginIds.length === 0) {
    settled.add(profileId);
    return;
  }
  const available = new Set(firstSignInHooks().map((hook) => hook.pluginId));
  // An unloaded plugin keeps its pending delivery until a Gateway start finds it again.
  const deliverable = record.pendingPluginIds.filter((pluginId) => available.has(pluginId));
  if (deliverable.length === 0) {
    settled.add(profileId);
    return;
  }
  let facts: Awaited<ReturnType<typeof readProfileFacts>>;
  try {
    facts = await readProfileFacts(profileId);
  } catch (error) {
    if (!(error instanceof UserProfileNotFoundError)) {
      throw error;
    }
    log.warn(`first sign-in delivery dropped for missing profile=${profileId}`);
    await store.register(profileId, { ...record, pendingPluginIds: [], attempts: {} });
    settled.add(profileId);
    return;
  }
  const event = {
    ...facts,
    isNewProfile: record.firstSignedInAt - facts.profileCreatedAt <= NEW_PROFILE_WINDOW_MS,
    firstSignedInAt: record.firstSignedInAt,
  };
  const ctx = { config: getRuntimeConfig() };
  const attempts = { ...record.attempts };
  const outcomes = await Promise.all(
    deliverable.map(async (pluginId) => {
      const attempt = (attempts[pluginId] ?? 0) + 1;
      try {
        await runPluginHandlers(pluginId, { ...event, attempt }, ctx);
        delete attempts[pluginId];
        return { pluginId, failedAttempt: 0 };
      } catch (error) {
        attempts[pluginId] = attempt;
        log.warn(
          `user_first_sign_in handler from ${pluginId} failed attempt=${attempt} profile=${profileId}: ${formatForLog(error)}`,
        );
        return { pluginId, failedAttempt: attempt };
      }
    }),
  );
  const delivered = new Set(outcomes.flatMap((o) => (o.failedAttempt ? [] : [o.pluginId])));
  const pendingPluginIds = record.pendingPluginIds.filter((pluginId) => !delivered.has(pluginId));
  await store.register(profileId, { ...record, pendingPluginIds, attempts });
  if (pendingPluginIds.length === 0) {
    settled.add(profileId);
    return;
  }
  const failedAttempt = Math.max(...outcomes.map((o) => o.failedAttempt));
  if (failedAttempt > 0) {
    scheduleRetry(profileId, failedAttempt);
  }
}

async function findMergedRecord(
  profileId: string,
): Promise<{ key: string; record: FirstSignInRecord } | undefined> {
  let aliases: string[];
  try {
    const identity = await prepareUserProfileIdentity(profileId);
    try {
      aliases = [...identity.readCurrentFacts().aliases].filter((id) => id !== profileId);
    } finally {
      identity.release();
    }
  } catch (error) {
    if (error instanceof UserProfileNotFoundError) {
      return undefined;
    }
    throw error;
  }
  const store = openRecords();
  for (const key of aliases.toSorted()) {
    const record = await store.lookup(key);
    if (record) {
      return { key, record };
    }
  }
  return undefined;
}

async function readProfileFacts(
  profileId: string,
): Promise<Omit<PluginHookUserFirstSignInEvent, "isNewProfile" | "firstSignedInAt" | "attempt">> {
  const catalog = await prepareUserProfileCatalog();
  try {
    const access = captureResidentUserProfileAccess(profileId);
    const row = access.assertCurrent();
    const facts = access.readCurrentFacts();
    return {
      profileId: facts.profileId,
      displayName: row.display_name?.trim() || null,
      emails: [...facts.emails],
      githubAccountIds: [...(facts.githubAccountIds ?? [])],
      profileCreatedAt: row.created_at,
    };
  } finally {
    catalog.release();
  }
}

function scheduleRetry(profileId: string, attempt: number): void {
  if (retryTimers.has(profileId)) {
    return;
  }
  const delayMs = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
  const timer = setTimeout(() => {
    retryTimers.delete(profileId);
    void runDelivery(profileId);
  }, delayMs);
  timer.unref?.();
  retryTimers.set(profileId, timer);
}

export async function settleUserFirstSignInDeliveriesForTests(): Promise<void> {
  while (running.size > 0) {
    await Promise.all(running.values());
  }
}

export function resetUserFirstSignInDeliveriesForTests(): void {
  for (const timer of retryTimers.values()) {
    clearTimeout(timer);
  }
  retryTimers.clear();
  deferrals.clear();
  running.clear();
  settled.clear();
}
