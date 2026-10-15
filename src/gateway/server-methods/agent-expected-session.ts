import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";

export type ExpectedExistingSessionConstraint = {
  sessionId: string;
  lifecycleRevision?: string | null;
};

export class ExpectedExistingSessionChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectedExistingSessionChangedError";
  }
}

export function resolveExpectedExistingSessionConstraint(params: {
  canUseInternalRuntimeHandoff: boolean;
  expectedExistingSessionId?: unknown;
  expectedExistingSessionLifecycleRevision?: string | null;
}): { ok: true; constraint?: ExpectedExistingSessionConstraint } | { ok: false; error: string } {
  const sessionId = normalizeOptionalString(params.expectedExistingSessionId);
  if (!sessionId) {
    if (params.expectedExistingSessionLifecycleRevision !== undefined) {
      return {
        ok: false,
        error: "expectedExistingSessionLifecycleRevision requires expectedExistingSessionId.",
      };
    }
    return { ok: true };
  }
  if (!params.canUseInternalRuntimeHandoff) {
    return {
      ok: false,
      error: "expectedExistingSessionId is reserved for backend callers.",
    };
  }
  return {
    ok: true,
    constraint: {
      sessionId,
      lifecycleRevision: params.expectedExistingSessionLifecycleRevision,
    },
  };
}

export function validateExpectedExistingSessionTarget(params: {
  constraint?: ExpectedExistingSessionConstraint;
  requestedSessionId?: string;
  requestedSessionKey?: string;
}): string | undefined {
  if (!params.constraint) {
    return undefined;
  }
  if (!params.requestedSessionKey) {
    return "expectedExistingSessionId requires an explicit session key.";
  }
  if (params.requestedSessionId && params.requestedSessionId !== params.constraint.sessionId) {
    return "conflicting session identity constraints.";
  }
  return undefined;
}

export function assertExpectedExistingSession(params: {
  constraint?: ExpectedExistingSessionConstraint;
  entry?: SessionEntry;
  message: string;
}): void {
  if (
    params.constraint &&
    (params.entry?.sessionId !== params.constraint.sessionId ||
      (params.constraint.lifecycleRevision !== undefined &&
        (params.entry?.lifecycleRevision ?? null) !== params.constraint.lifecycleRevision))
  ) {
    throw new ExpectedExistingSessionChangedError(params.message);
  }
}
