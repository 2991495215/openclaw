import { prepareNativeSessionGenerationAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { patchSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { z } from "zod";
import {
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore,
} from "./app-server/auth-profile.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { requestCodexAppServerJson } from "./app-server/request.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";

const paramsSchema = z
  .object({
    agentId: z.string().trim().min(1),
    sessionKey: z.string().trim().min(1),
    expectedSessionId: z.string().trim().min(1),
    expectedThreadId: z.string().trim().min(1),
    expectedClientId: z.string().trim().min(1).nullable(),
    expectedAuthProfileId: z.string().trim().min(1),
    expectedAccountEmail: z.string().trim().email(),
    expectedServerUrl: z.string().url(),
    apply: z.boolean().default(false),
    confirmNativeAccount: z.boolean().default(false),
  })
  .strict();

export async function handleCodexAuthProfileMigration(
  options: GatewayRequestHandlerOptions,
  bindingStore: Pick<CodexAppServerBindingStore, "mutate">,
): Promise<void> {
  const { respond, context, signal, hasCurrentClientAuthority } = options;
  const parsed = paramsSchema.safeParse(options.params);
  if (!parsed.success) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Expected exact session, binding, retired profile, native account and endpoint identities.",
      ),
    );
    return;
  }
  const params = parsed.data;
  const config = context.getRuntimeConfig();
  if (!listAgentIds(config).includes(params.agentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Unknown agent."));
    return;
  }
  try {
    if (params.apply && !params.confirmNativeAccount) {
      throw new Error("Apply requires explicit confirmation of the native account migration.");
    }
    const agentDir = resolveAgentDir(config, params.agentId);
    const assertCurrent = () => {
      if (
        signal?.aborted ||
        hasCurrentClientAuthority?.() === false ||
        context.getRuntimeConfig() !== config
      ) {
        throw new Error("Auth profile migration authority or configuration changed.");
      }
      const store = resolveCodexAppServerAuthProfileStore({
        agentDir,
        config,
        authProfileId: params.expectedAuthProfileId,
      });
      if (
        store.profiles[params.expectedAuthProfileId] ||
        config.auth?.profiles?.[params.expectedAuthProfileId] ||
        Object.values(config.auth?.order ?? {}).some((order) =>
          order.includes(params.expectedAuthProfileId),
        ) ||
        resolveCodexAppServerAuthProfileIdForAgent({ agentDir, config, authProfileStore: store })
      ) {
        throw new Error(
          "The retired profile or another automatic Codex auth selection is still configured.",
        );
      }
    };
    assertCurrent();
    const { start } = resolveCodexAppServerRuntimeOptions({
      pluginConfig: config.plugins?.entries?.codex?.config,
    });
    if (start.transport !== "websocket" || start.url !== params.expectedServerUrl) {
      throw new Error("Migration requires the explicitly identified managed websocket endpoint.");
    }
    const account = await requestCodexAppServerJson({
      method: "account/read",
      requestParams: { refreshToken: false },
      startOptions: start,
      authProfileId: null,
      agentDir,
      config,
      timeoutMs: 20_000,
      signal,
      assertCurrent,
    });
    if (
      account.account?.type !== "chatgpt" ||
      account.account.email?.toLowerCase() !== params.expectedAccountEmail.toLowerCase()
    ) {
      throw new Error("The native account does not match the explicitly confirmed owner.");
    }
    assertCurrent();
    const identity = {
      kind: "session" as const,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.expectedSessionId,
    };
    const storePath = resolveStorePath(config.session?.store, { agentId: params.agentId });
    const prepared = await prepareNativeSessionGenerationAuthority({
      target: identity,
      config,
      storePath,
      assertCurrent,
      createSupersededError: () => new Error("The session generation changed; migration refused."),
    });
    if (prepared.state !== "current") {
      throw new Error("Migration requires an existing current session generation.");
    }
    const mutation = {
      kind: "clear-auth-profile" as const,
      threadId: params.expectedThreadId,
      clientId: params.expectedClientId ?? undefined,
      expectedAuthProfileId: params.expectedAuthProfileId,
      dryRun: true,
    };
    if (!(await bindingStore.mutate(identity, mutation, assertCurrent, prepared.authority))) {
      throw new Error("Binding changed or has native child ownership; migration refused.");
    }
    let outerProfileCleared = false;
    // Clear the outer producer first. If binding CAS later refuses, the remaining
    // retired binding still fails closed and the operator can safely inspect/retry.
    await patchSessionEntry({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath,
      skipMaintenance: true,
      preserveActivity: true,
      assertCommitAllowed: assertCurrent,
      update: (entry) => {
        if (
          entry.sessionId !== params.expectedSessionId ||
          entry.status === "running" ||
          (entry.authProfileOverride !== undefined &&
            entry.authProfileOverride !== params.expectedAuthProfileId)
        ) {
          throw new Error(
            "Session generation, activity or auth selection changed; migration refused.",
          );
        }
        outerProfileCleared = entry.authProfileOverride === params.expectedAuthProfileId;
        return params.apply && outerProfileCleared
          ? {
              authProfileOverride: undefined,
              authProfileOverrideSource: undefined,
              authProfileOverrideCompactionCount: undefined,
            }
          : null;
      },
    });
    if (
      params.apply &&
      !(await bindingStore.mutate(
        identity,
        { ...mutation, dryRun: false },
        assertCurrent,
        prepared.authority,
      ))
    ) {
      throw new Error("Binding changed after outer selection cleanup; inspect before retrying.");
    }
    respond(true, {
      applied: params.apply,
      sessionId: params.expectedSessionId,
      threadId: params.expectedThreadId,
      nativeAccountVerified: true,
      outerProfileCleared: params.apply && outerProfileCleared,
    });
  } catch (error) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        error instanceof Error ? error.message : "Auth profile migration refused.",
      ),
    );
  }
}
