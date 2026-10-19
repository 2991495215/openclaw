import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { redactSensitiveText } from "../../logging/redact.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";

export type MainSessionRecoverySkipReason =
  | "stopped"
  | "not_main_session"
  | "archived"
  | "work_start_blocked"
  | "work_start_pending"
  | "dispatch_target_unavailable"
  | "live_owner"
  | "already_handled"
  | "state_changed"
  | "inactive"
  | "blocked"
  | "tombstoned"
  | "exhausted"
  | "message_action_authority_unavailable"
  | "observation_only"
  | "pending_delivery"
  | "invalid_harness_completion"
  | "delegated_authority_unavailable"
  | "dispatch_skipped";

export type MainSessionRecoveryDecision = {
  decision: "started" | "settled" | "deferred" | "blocked";
  reason: string;
  nextOwner: string;
};

export function skippedMainSessionRecoveryDecision(
  reason: MainSessionRecoverySkipReason,
): MainSessionRecoveryDecision {
  switch (reason) {
    case "exhausted":
    case "tombstoned":
    case "message_action_authority_unavailable":
    case "delegated_authority_unavailable":
    case "work_start_blocked":
    case "dispatch_target_unavailable":
      return { decision: "blocked", reason, nextOwner: "operator" };
    case "work_start_pending":
      return { decision: "deferred", reason, nextOwner: "session-preparation" };
    case "pending_delivery":
      return { decision: "deferred", reason, nextOwner: "outbound-delivery" };
    case "archived":
      return { decision: "deferred", reason, nextOwner: "none" };
    case "live_owner":
    case "blocked":
    case "already_handled":
    case "inactive":
      return { decision: "deferred", reason, nextOwner: "session-owner" };
    case "invalid_harness_completion":
      return { decision: "settled", reason, nextOwner: "none" };
    case "stopped":
      return { decision: "deferred", reason, nextOwner: "next-startup" };
    default:
      return { decision: "deferred", reason, nextOwner: "main-session-recovery" };
  }
}

export type RestartRecoveryStoreTarget = Pick<
  MainSessionRecoveryStoreTarget,
  "agentId" | "storePath"
>;

const failures = new Map<string, string>();

export function restartRecoveryStoreTargetKey(target: RestartRecoveryStoreTarget): string {
  return JSON.stringify([target.agentId, target.storePath]);
}

/** The marker records its outcome; diagnostics never infer successful recovery from a reread. */
export function recordStartupRecoveryStoreResult(params: {
  target: RestartRecoveryStoreTarget;
  outcome: { ok: true } | { ok: false; error: unknown };
}): void {
  const key = restartRecoveryStoreTargetKey(params.target);
  if (params.outcome.ok) {
    failures.delete(key);
  } else {
    failures.set(
      key,
      truncateWithMarker(
        sanitizeTerminalText(
          redactSensitiveText(
            `${params.target.agentId ?? "session store"}: ${String(params.outcome.error)}`,
            { mode: "tools" },
          ),
        ),
        2000,
        { marker: "… (see recovery log)", reserve: 22, trimEnd: true },
      ),
    );
  }
}

export function readStartupRecoveryWarning(includeSensitive = true): string | undefined {
  if (failures.size === 0) {
    return undefined;
  }
  const summary = `Startup session recovery is incomplete for ${failures.size} session store(s).`;
  const hint =
    "Inspect the Gateway recovery logs and retry the affected session after repairing its store.";
  const details = includeSensitive
    ? `\n${truncateWithMarker([...failures.values()].map((failure) => `- ${failure}`).join("\n"), 2000, { marker: "… (see recovery log)", reserve: 22, trimEnd: true })}`
    : "";
  return `${summary}${details}\n${hint}`;
}
