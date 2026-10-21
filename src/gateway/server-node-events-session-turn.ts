// Owns node-originated voice turns and their session-store writes.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { agentCommandFromIngress } from "../commands/agent.js";
import { getRuntimeConfig } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAgentHarnessSessionContextError } from "../sessions/agent-harness-session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { parseNodeEventPayload, type NodeEventSessionSource } from "./server-node-event-source.js";
import type {
  NodeEvent,
  NodeEventContext,
  NodeEventHandlerOptions,
} from "./server-node-events-types.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { formatForLog } from "./ws-log.js";

const VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS = 1500;
const MAX_RECENT_VOICE_TRANSCRIPTS = 200;

const recentVoiceTranscripts = new Map<string, { fingerprint: string; ts: number }>();
type VoiceTranscriptReservationAdmission = { work: Promise<unknown> } | null;
type VoiceTranscriptReservation = {
  fingerprint: string;
  receivedAt: number;
  status: "pending" | "ready" | "checking" | "rejected";
  isConnectionCurrent?: () => boolean | Promise<boolean>;
  assertCurrent?: () => void;
  start?: () => Promise<unknown>;
  resolve: (admission: VoiceTranscriptReservationAdmission) => void;
  rejectDecision: (reason: unknown) => void;
};
const pendingVoiceTranscriptReservations = new Map<string, VoiceTranscriptReservation[]>();

function normalizeFiniteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function resolveVoiceTranscriptFingerprint(obj: Record<string, unknown>, text: string): string {
  const eventId =
    normalizeOptionalString(obj.eventId) ??
    normalizeOptionalString(obj.providerEventId) ??
    normalizeOptionalString(obj.transcriptId);
  if (eventId) {
    return `event:${eventId}`;
  }

  const callId = normalizeOptionalString(obj.providerCallId) ?? normalizeOptionalString(obj.callId);
  const sequence = normalizeFiniteInteger(obj.sequence) ?? normalizeFiniteInteger(obj.seq);
  if (callId && sequence !== null) {
    return `call-seq:${callId}:${sequence}`;
  }

  const eventTimestamp =
    normalizeFiniteInteger(obj.timestamp) ??
    normalizeFiniteInteger(obj.ts) ??
    normalizeFiniteInteger(obj.eventTimestamp);
  if (callId && eventTimestamp !== null) {
    return `call-ts:${callId}:${eventTimestamp}`;
  }

  if (eventTimestamp !== null) {
    return `timestamp:${eventTimestamp}|text:${text}`;
  }

  return `text:${text}`;
}

function shouldDropDuplicateVoiceTranscript(params: {
  sessionKey: string;
  fingerprint: string;
  now: number;
}): boolean {
  // Voice providers can replay identical transcript fragments during reconnect.
  // Keep only a bounded last fingerprint per session to avoid duplicate sends.
  const previous = recentVoiceTranscripts.get(params.sessionKey);
  if (
    previous &&
    previous.fingerprint === params.fingerprint &&
    params.now - previous.ts <= VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS
  ) {
    return true;
  }
  recentVoiceTranscripts.set(params.sessionKey, {
    fingerprint: params.fingerprint,
    ts: params.now,
  });

  if (recentVoiceTranscripts.size > MAX_RECENT_VOICE_TRANSCRIPTS) {
    const cutoff = params.now - VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS * 2;
    for (const [key, value] of recentVoiceTranscripts) {
      if (value.ts < cutoff) {
        recentVoiceTranscripts.delete(key);
      }
      if (recentVoiceTranscripts.size <= MAX_RECENT_VOICE_TRANSCRIPTS) {
        break;
      }
    }
    pruneMapToMaxSize(recentVoiceTranscripts, MAX_RECENT_VOICE_TRANSCRIPTS);
  }

  return false;
}

type LoadedSessionEntry = Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>;

export async function touchNodeSessionStore(params: {
  storePath: LoadedSessionEntry["storePath"];
  canonicalKey: LoadedSessionEntry["canonicalKey"];
  sessionId: string;
  now: number;
  assertCurrent?: () => void;
}) {
  const { storePath } = params;
  if (!storePath) {
    return;
  }
  await upsertSessionEntryCore(
    {
      sessionKey: params.canonicalKey,
      storePath,
    },
    {
      sessionId: params.sessionId,
      updatedAt: params.now,
    },
    { workerGuard: { assertCurrent: params.assertCurrent } },
  );
}

function queueSessionStoreTouch(
  params: Parameters<typeof touchNodeSessionStore>[0] & {
    ctx: NodeEventContext;
    isConnectionCurrent?: () => boolean | Promise<boolean>;
  },
): Promise<void> {
  // Voice dispatch intentionally does not wait for persistence, but a host
  // snapshot must not race the accepted write after its node RPC returns.
  return runWithGatewayIndependentRootWorkContinuation(async () => {
    if (params.isConnectionCurrent && !(await params.isConnectionCurrent())) {
      return;
    }
    await touchNodeSessionStore(params);
  }, "node-events:voice-persist").catch((err: unknown) => {
    params.ctx.logGateway.warn("voice session-store update failed: " + formatForLog(err));
  });
}

export async function handleNodeVoiceTranscript(
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  opts?: NodeEventHandlerOptions,
  source?: NodeEventSessionSource,
): Promise<undefined> {
  const obj = parseNodeEventPayload(evt.payloadJSON);
  if (!obj) {
    return undefined;
  }
  const text = normalizeOptionalString(obj.text) ?? "";
  if (!text) {
    return undefined;
  }
  if (text.length > 20_000) {
    return undefined;
  }
  const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? "";
  const cfg = getRuntimeConfig();
  const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
  const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : rawMainKey;
  const { storePath, entry, canonicalKey } =
    source?.loaded ??
    (await loadGatewaySessionEntryReadOnlyInWorker({
      cfg,
      key: sessionKey,
      excludeInternalEffects: true,
    }));
  if (resolveAgentHarnessSessionContextError(canonicalKey, entry)) {
    return undefined;
  }
  const receivedAt = Date.now();
  const fingerprint = resolveVoiceTranscriptFingerprint(obj, text);
  const sessionId = entry?.sessionId ?? randomUUID();
  const runId = randomUUID();
  source?.assertCurrent();
  // Resolve reservations in receipt order so delayed currentness checks cannot
  // change the dedupe window, while rejected connections leave no committed state.
  const decision = createDeferredCore<VoiceTranscriptReservationAdmission>();
  const reservation: VoiceTranscriptReservation = {
    fingerprint,
    receivedAt,
    status: "pending",
    resolve: decision.resolve,
    rejectDecision: decision.reject,
    assertCurrent: source?.assertCurrent,
  };
  const queue = pendingVoiceTranscriptReservations.get(canonicalKey) ?? [];
  queue.push(reservation);
  pendingVoiceTranscriptReservations.set(canonicalKey, queue);

  const drain = () => {
    while (queue[0]?.status === "rejected") {
      queue.shift()?.resolve(null);
    }
    const next = queue[0];
    if (!next) {
      pendingVoiceTranscriptReservations.delete(canonicalKey);
      return;
    }
    if (next.status !== "ready") {
      return;
    }
    next.status = "checking";
    void (async () => {
      try {
        const isCurrent = next.isConnectionCurrent ? await next.isConnectionCurrent() : true;
        next.assertCurrent?.();
        const admission =
          isCurrent &&
          !shouldDropDuplicateVoiceTranscript({
            sessionKey: canonicalKey,
            fingerprint: next.fingerprint,
            now: next.receivedAt,
          }) &&
          next.start
            ? { work: next.start() }
            : null;
        next.resolve(admission);
      } catch (err) {
        next.rejectDecision(err);
      } finally {
        queue.shift();
        drain();
      }
    })();
  };
  const settle = (status: "ready" | "rejected") => {
    if (reservation.status !== "pending") {
      return;
    }
    reservation.status = status;
    drain();
  };

  const isConnectionCurrent = opts?.isConnectionCurrent;
  const voiceWork = runWithGatewayIndependentRootWorkContinuation(async () => {
    if (isConnectionCurrent && !(await isConnectionCurrent())) {
      settle("rejected");
      return;
    }
    reservation.isConnectionCurrent = isConnectionCurrent;
    reservation.start = () => {
      const touch = queueSessionStoreTouch({
        ctx,
        storePath,
        canonicalKey,
        sessionId,
        now: receivedAt,
        assertCurrent: source?.assertCurrent,
        isConnectionCurrent: opts?.isConnectionCurrent,
      });

      source?.pending.push(touch);

      // Voice now has a unique per-turn run id, so it is also the stable
      // client identity for chat streaming and abort lifecycle ownership.
      ctx.addChatRun(runId, {
        sessionKey: canonicalKey,
        clientRunId: runId,
      });
      return agentCommandFromIngress(
        {
          runId,
          message: text,
          sessionId,
          sessionKey: canonicalKey,
          thinking: "low",
          deliver: false,
          messageChannel: "node",
          inputProvenance: {
            kind: "external_user",
            sourceChannel: "voice",
            sourceTool: "gateway.voice.transcript",
          },
          allowModelOverride: false,
        },
        defaultRuntime,
        ctx.deps,
      );
    };
    settle("ready");
    const admission = await decision.promise;
    if (!admission) {
      return;
    }
    await admission.work;
  }, "node-events:voice-turn").catch((err: unknown) => {
    settle("rejected");
    ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
  });
  source?.pending.push(voiceWork);
  return undefined;
}
