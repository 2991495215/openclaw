/** User sign-in hook contracts shared by the Gateway owner and plugin consumers. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AsyncPluginHook } from "./hook-handler.types.js";

/**
 * A verified person signed in to this Gateway for the first time.
 *
 * Delivery is at least once per handler plugin: a failed, timed-out, or interrupted
 * handler is retried later, so handlers must be idempotent (key effects by `profileId`
 * or by their own durable record).
 */
export type PluginHookUserFirstSignInEvent = {
  /** Canonical profile id of the person who signed in. */
  profileId: string;
  displayName: string | null;
  /** Verified sign-in emails currently bound to the profile, sorted. */
  emails: string[];
  /** Verified GitHub account ids currently bound to the profile. */
  githubAccountIds: number[];
  /** True when the profile was created at most one minute before its first sign-in. */
  isNewProfile: boolean;
  /** Epoch milliseconds when the profile was created. */
  profileCreatedAt: number;
  /** Epoch milliseconds when the Gateway durably recorded this first sign-in. */
  firstSignedInAt: number;
  /** One-based delivery attempt for this plugin; values above 1 are retries. */
  attempt: number;
};

export type PluginHookUserFirstSignInContext = {
  config: OpenClawConfig;
};

export type PluginHookUserFirstSignInHook = AsyncPluginHook<
  PluginHookUserFirstSignInEvent,
  PluginHookUserFirstSignInContext
>;
