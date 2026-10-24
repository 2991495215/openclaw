import {
  freezeJsonSnapshot,
  freezeTrustedJsonSnapshot,
  isDeeplyFrozenPlainData,
} from "../shared/immutable-data.js";
import {
  isInternalDiagnosticEventInterested,
  type InternalDiagnosticEventInterest,
} from "./diagnostic-event-listener-presence.js";
import {
  getActiveDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "./diagnostic-trace-context.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

export type DiagnosticBaseEvent = {
  ts: number;
  seq: number;
  trace?: DiagnosticTraceContext;
};

export type DiagnosticEventMetadata = Readonly<{
  internal?: boolean;
  trustedTraceContext?: boolean;
  trusted: boolean;
}>;

/** Owned envelopes contain data properties; their nested values still belong to producers. */
export function cloneDiagnosticValueForListener<T extends object>(value: T, owned = false): T {
  if (isDeeplyFrozenPlainData(value)) {
    return value;
  }
  if (
    owned &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(value).every(isDeeplyFrozenPlainData)
  ) {
    return freezeTrustedJsonSnapshot(value);
  }
  // Opaque values stay listener-local; the shared owner only admits plain graphs.
  return freezeJsonSnapshot(structuredClone(value));
}

/** Capture lazily so filtered listeners never read the producer's payload. */
export function createDiagnosticValueForListeners<T extends object>(
  value: T,
  owned = false,
): () => T {
  let shared: T | undefined;
  return () => {
    const snapshot = shared ?? cloneDiagnosticValueForListener(value, owned);
    if (isDeeplyFrozenPlainData(snapshot)) {
      shared = snapshot;
    }
    return snapshot;
  };
}

export function enrichDiagnosticEvent<const T extends object>(
  state: { seq: number },
  event: T,
  captureActiveTrace = true,
): T & DiagnosticBaseEvent {
  const enriched: Record<string, unknown> = {};
  for (const key of Object.keys(event)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    enriched[key] = Reflect.get(event, key);
  }
  if (captureActiveTrace) {
    enriched.trace ??= getActiveDiagnosticTraceContext();
  }
  enriched.seq = ++state.seq;
  enriched.ts = Date.now();
  // SAFETY: The producer fields have been copied and the dispatcher metadata is now populated.
  return enriched as T & DiagnosticBaseEvent;
}

export function captureQueuedDiagnosticEvent(
  entry: {
    event: { type: string };
    metadata: DiagnosticEventMetadata;
    privateData?: object;
    trustedListenersOnly?: boolean;
  },
  interests: Iterable<
    | (InternalDiagnosticEventInterest & {
        includePrivateData?: boolean;
      })
    | undefined
  >,
): boolean {
  try {
    let interested = false;
    let includePrivateData = false;
    if (entry.privateData || entry.trustedListenersOnly) {
      for (const interest of interests) {
        if (
          isInternalDiagnosticEventInterested(interest, entry.event.type, entry.metadata.trusted)
        ) {
          interested = true;
          if (interest?.includePrivateData !== false) {
            includePrivateData = true;
            break;
          }
        }
      }
    }
    if (entry.trustedListenersOnly && !interested) {
      return false;
    }
    entry.event = cloneDiagnosticValueForListener(entry.event, true);
    if (entry.privateData) {
      try {
        entry.privateData = includePrivateData
          ? cloneDiagnosticValueForListener(entry.privateData)
          : undefined;
      } catch (error) {
        entry.privateData = undefined;
        console.error(
          `[diagnostic-events] private snapshot error type=${entry.event.type}: ${String(error)}`,
        );
      }
    }
    return true;
  } catch (error) {
    console.error(
      `[diagnostic-events] queue snapshot error type=${entry.event.type}: ${String(error)}`,
    );
    return false;
  }
}

/** Returns whether listener metadata marks dispatcher-internal provenance. */
export function isInternalDiagnosticEventMetadata(metadata: DiagnosticEventMetadata): boolean {
  return metadata.internal === true;
}
