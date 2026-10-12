import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { resolveGatewaySessionStoreTargetWithStoreAsync } from "../session-utils-store-lookup.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

export function requirePreparedTalkSessionTarget(
  target: PreparedTalkSessionTarget | undefined,
): PreparedTalkSessionTarget {
  if (!target) {
    throw new Error("Talk session target was not prepared by the Gateway");
  }
  return target;
}

/** Resolve Talk ownership before aliases collapse, then retain the exact storage target. */
export async function prepareTalkSessionTarget(
  cfg: OpenClawConfig,
  requestedSessionKey?: string,
): Promise<PreparedTalkSessionTarget> {
  const requestedKey = normalizeOptionalString(requestedSessionKey);
  const owner = resolveTalkSessionAgentId(cfg, requestedKey ?? "main");
  const sessionKey = requestedKey ?? resolveAgentMainSessionKey({ cfg, agentId: owner });
  const { agentId, canonicalKey, storePath } = await resolveTalkSessionStorageTarget(
    cfg,
    sessionKey,
    owner,
  );
  const assertCurrent = captureSessionMutationRouting(
    cfg,
    () => new Error("Talk session storage target changed; retry the request"),
    [{ sessionKey, agentId }],
  );
  return Object.freeze({ agentId, sessionKey, canonicalKey, storePath, assertCurrent });
}

/** Revalidate a retained owner without consulting the current ambient Talk default. */
export function assertTalkSessionStorageTarget(
  cfg: OpenClawConfig,
  target: PreparedTalkSessionTarget,
): void {
  target.assertCurrent(cfg);
  const current = resolveSessionStoreIdentity({
    cfg,
    sessionKey: target.sessionKey,
    agentId: resolveConfiguredAgentId(cfg, target.agentId),
  });
  if (current.agentId !== target.agentId || current.canonicalKey !== target.canonicalKey) {
    throw new Error("Talk session storage target changed; retry the request");
  }
}

async function resolveTalkSessionStorageTarget(
  cfg: OpenClawConfig,
  sessionKey: string,
  owner: string,
) {
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg,
    sessionKey,
    agentId: resolveConfiguredAgentId(cfg, owner),
  });
  const target = await resolveGatewaySessionStoreTargetWithStoreAsync({
    cfg,
    key: canonicalKey,
    agentId,
    readOnly: true,
    exactRead: true,
  });
  return { agentId, canonicalKey, storePath: target.storePath };
}
