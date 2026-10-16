/**
 * Optional content-free Anthropic request/usage JSONL diagnostics.
 * Stores request digests and numeric usage without message, tool, or error content.
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
  usage?: unknown;
  error?: string;
  payloadDigest?: string;
};

const writers = new Map<string, QueuedFileWriter>();
const log = createSubsystemLogger("agent/anthropic-payload");

function digest(value: unknown): string | undefined {
  // Hash the redacted payload so repeated requests can be correlated even when
  // payload bodies are too sensitive to inspect directly.
  const serialized = safeJsonStringify(value);
  if (!serialized) {
    return undefined;
  }
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function findLastAssistantUsage(messages: AgentMessage[]): Record<string, unknown> | null {
  // Usage is attached to assistant messages after streaming; walk backwards to
  // avoid logging stale usage from an earlier assistant turn.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as { role?: unknown; usage?: unknown };
    if (msg?.role === "assistant" && msg.usage && typeof msg.usage === "object") {
      return msg.usage as Record<string, unknown>;
    }
  }
  return null;
}

type AnthropicPayloadLogger = {
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
  recordUsage: (messages: AgentMessage[], error?: unknown) => void;
};

export function createAnthropicPayloadLogger(
  params: AgentTraceBase & {
    env?: NodeJS.ProcessEnv;
    writer?: QueuedFileWriter;
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

  const writer = params.writer ?? getQueuedFileWriter(writers, filePath);
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
        // Preserve the existing digest without persisting the diagnostic payload.
        const redactedPayload = redactAgentDiagnosticPayload(payload);
        record({
          ...base,
          ts: new Date().toISOString(),
          stage: "request",
          payloadDigest: digest(redactedPayload),
        });
        return options?.onPayload?.(payload, model);
      };
      return streamFn(model, context, {
        ...options,
        onPayload: nextOnPayload,
      });
    };

  const recordUsage: AnthropicPayloadLogger["recordUsage"] = (messages, error) => {
    const usage = findLastAssistantUsage(messages);
    const errorMessage = error === undefined || error === null ? undefined : "request_failed";
    if (!usage && !errorMessage) {
      return;
    }
    const usageCounters = usage
      ? Object.fromEntries(
          Object.entries(usage).filter(
            ([key, value]) =>
              ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].includes(key) &&
              typeof value === "number" &&
              Number.isFinite(value),
          ),
        )
      : undefined;
    record({
      ...base,
      ts: new Date().toISOString(),
      stage: "usage",
      ...(usageCounters ? { usage: usageCounters } : {}),
      error: errorMessage,
    });
    if (usage) {
      log.info("anthropic usage", {
        runId: params.runId,
        sessionId: params.sessionId,
        usage: usageCounters,
      });
    }
  };

  log.info("anthropic payload logger enabled", { filePath: writer.filePath });
  return { wrapStreamFn, recordUsage };
}
