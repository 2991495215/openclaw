/**
 * Optional Anthropic request/usage JSONL diagnostics.
 * Redacts payload content before writing and stores digests for correlation
 * without persisting raw secret-bearing request bodies.
 */
import crypto from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { redactAgentDiagnosticPayload } from "./diagnostic-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";
import type { AgentMessage, StreamFn } from "./runtime/index.js";
import { buildAgentTraceBase, type AgentTraceBase } from "./trace-base.js";

type PayloadLogStage = "request" | "usage";

type PayloadLogEvent = AgentTraceBase & {
  ts: string;
  stage: PayloadLogStage;
  payload?: unknown;
  usage?: unknown;
  error?: string;
  payloadDigest?: string;
};

const writers = new Map<string, QueuedFileWriter>();
const log = createSubsystemLogger("agent/anthropic-payload");

type AnthropicPayloadLogger = {
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
  recordUsage: (messages: AgentMessage[], error?: unknown) => void;
};

export function createAnthropicPayloadLogger(
  params: AgentTraceBase & {
    env?: NodeJS.ProcessEnv;
  },
): AnthropicPayloadLogger | null {
  const env = params.env ?? process.env;
  const enabled = parseBooleanValue(env.OPENCLAW_ANTHROPIC_PAYLOAD_LOG) ?? false;
  const fileOverride = env.OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "anthropic-payload.jsonl");
  if (!enabled || isIncognitoSessionKey(params.sessionKey)) {
    return null;
  }

  const writer = getQueuedFileWriter(writers, filePath);
  const base = buildAgentTraceBase(params);

  const record = (event: PayloadLogEvent) => {
    const line = safeJsonStringify(event);
    if (!line) {
      return;
    }
    writer.write(`${line}\n`);
  };

  const wrapStreamFn: AnthropicPayloadLogger["wrapStreamFn"] =
    (streamFn) => (model, context, options) => {
      if (model?.api !== "anthropic-messages") {
        return streamFn(model, context, options);
      }
      const nextOnPayload = (payload: unknown) => {
        // Forward the original payload to the provider hook, but persist only
        // the redacted diagnostic copy.
        const redactedPayload = redactAgentDiagnosticPayload(payload);
        const event: PayloadLogEvent = {
          ...base,
          ts: new Date().toISOString(),
          stage: "request",
          payload: redactedPayload,
        };
        // Hash the redacted payload so repeated requests can be correlated even when
        // payload bodies are too sensitive to inspect directly.
        const serialized = safeJsonStringify(redactedPayload);
        event.payloadDigest = serialized
          ? crypto.createHash("sha256").update(serialized).digest("hex")
          : undefined;
        record(event);
        return options?.onPayload?.(payload, model);
      };
      return streamFn(model, context, {
        ...options,
        onPayload: nextOnPayload,
      });
    };

  const recordUsage: AnthropicPayloadLogger["recordUsage"] = (messages, error) => {
    // Usage is attached to assistant messages after streaming; walk backwards to
    // avoid logging stale usage from an earlier assistant turn.
    const usage = messages.findLast((message) => message?.role === "assistant")?.usage ?? null;
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
    const errorMessage =
      message !== undefined
        ? redactAgentDiagnosticPayload(message)
        : typeof error === "number" || typeof error === "boolean" || typeof error === "bigint"
          ? String(error)
          : error && typeof error === "object"
            ? (safeJsonStringify(redactAgentDiagnosticPayload(error)) ?? "unknown error")
            : undefined;
    if (!usage && !errorMessage) {
      return;
    }
    record({
      ...base,
      ts: new Date().toISOString(),
      stage: "usage",
      ...(usage ? { usage: redactAgentDiagnosticPayload(usage) } : {}),
      error: errorMessage,
    });
    if (usage) {
      log.info("anthropic usage", {
        runId: params.runId,
        sessionId: params.sessionId,
        usage,
      });
    }
  };

  log.info("anthropic payload logger enabled", { filePath: writer.filePath });
  return { wrapStreamFn, recordUsage };
}
