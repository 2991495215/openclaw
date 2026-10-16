import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  isResearchAdapterRequest,
  type ResearchAdapterReply,
} from "openclaw/plugin-sdk/research-adapter-contract";
import { executeGoogleResearch, GoogleResearchError } from "./research.js";

export async function handleGoogleResearch(
  api: OpenClawPluginApi,
  options: GatewayRequestHandlerOptions,
) {
  const { params, respond, sessionAccessAuthority: authority } = options;
  let startReturned = false;
  let receipt: Extract<ResearchAdapterReply, { ok: false }>["handle"];
  try {
    if (!authority) {
      throw new Error("Research requires current session authority.");
    }
    authority.assertCurrent();
    const config = api.pluginConfig?.research;
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      !("enabled" in config) ||
      config.enabled !== true ||
      !("profileId" in config) ||
      typeof config.profileId !== "string" ||
      !config.profileId.trim()
    ) {
      throw new Error("Google managed research is not explicitly enabled with an API-key profile.");
    }
    if (!isResearchAdapterRequest(params.request)) {
      throw new Error("Invalid versioned research request.");
    }
    const request = params.request;
    const { version: _version, ...input } = request;
    if (
      (input.action === "poll" || input.action === "cancel") &&
      input.handle.profileId !== config.profileId
    ) {
      throw new Error(
        "Research credential owner changed; the recorded job cannot switch profiles.",
      );
    }
    const value = await executeGoogleResearch(
      input.action === "start" ? { ...input, profileId: config.profileId } : input,
      {
        api,
        agentId: authority.target.agentId,
        signal: options.signal ?? AbortSignal.timeout(60_000),
        assertCurrent: authority.assertCurrent,
      },
    );
    startReturned = input.action === "start";
    if ("handle" in value) {
      receipt = value.handle;
    }
    authority.assertCurrent();
    const reply: ResearchAdapterReply = { version: 1, ok: true, value };
    respond(true, reply);
  } catch (error) {
    const reply: ResearchAdapterReply =
      error instanceof GoogleResearchError
        ? {
            version: 1,
            ok: false,
            state: error.state,
            reason: error.message,
            ...(error.handle ? { handle: error.handle } : {}),
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
          }
        : {
            version: 1,
            ok: false,
            state: startReturned ? "indeterminate" : "blocked",
            // A handle is not authority. Preserve a known receipt without publishing
            // report content; every reconciliation must pass fresh host/profile fences.
            ...(receipt ? { handle: receipt } : {}),
            reason: startReturned
              ? "Google research returned a submission, but authority changed before delivery. Do not repeat the start request."
              : "Google research is unavailable under the current configuration or session authority.",
          };
    respond(true, reply);
  }
}
