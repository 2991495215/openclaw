import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const PLUGIN_GATEWAY_SESSION_MUTATION_METHODS = new Set([
  "agent",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "message.action",
  "plugins.sessionAction",
  "send",
  "sessions.abort",
  "sessions.compact",
  "sessions.branches.switch",
  "sessions.rewind",
  "sessions.fork",
  "sessions.create",
  "sessions.delete",
  "sessions.patchMany",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reset",
  "sessions.send",
  "sessions.steer",
  "wake",
]);

const PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS = new Set([
  "sessions.cleanup",
  "sessions.groups.delete",
  "sessions.groups.rename",
]);

export function createPluginGatewaySessionOwnershipAssertion(
  pluginId: string,
  assertSessionIdentitiesOwned: (params: {
    action: string;
    agentId?: unknown;
    sessionFiles?: unknown[];
    sessionIds?: unknown[];
    sessionKeys?: unknown[];
    storePath?: unknown;
  }) => void,
) {
  return (method: string, params: Record<string, unknown> | undefined): void => {
    if (PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS.has(method)) {
      throw new Error(`Plugin "${pluginId}" cannot request global session mutation "${method}".`);
    }
    if (!PLUGIN_GATEWAY_SESSION_MUTATION_METHODS.has(method)) {
      return;
    }
    const request = params ?? {};
    if (method === "sessions.patchMany" && Array.isArray(request.targets)) {
      for (const target of request.targets) {
        if (!isRecord(target)) {
          continue;
        }
        assertSessionIdentitiesOwned({
          action: `request gateway method "${method}" for`,
          agentId: target.agentId,
          sessionKeys: [target.key],
        });
      }
      return;
    }
    const sessionKeys = [request.sessionKey, request.key, request.parentSessionKey];
    const sessionIds = [request.sessionId];
    assertSessionIdentitiesOwned({
      action: `request gateway method "${method}" for`,
      agentId: request.agentId,
      sessionIds,
      sessionKeys,
    });
    if (
      method === "sessions.abort" &&
      !sessionKeys.some((value) => normalizeOptionalString(value)) &&
      !sessionIds.some((value) => normalizeOptionalString(value))
    ) {
      throw new Error(
        `Plugin "${pluginId}" must provide a session key when requesting gateway method "${method}".`,
      );
    }
  };
}
