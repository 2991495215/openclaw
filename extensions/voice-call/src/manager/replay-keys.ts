import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";

/** Match the existing voice-call webhook replay-cache cardinality. */
const MAX_MANAGER_REPLAY_KEYS = 10_000;
/** Keep typical provider replay IDs near one raw persisted-record chunk. */
export const MAX_CALL_REPLAY_KEYS = 500;

/** Remember one manager replay key without refreshing duplicate insertion order. */
export function rememberManagerReplayKey(keys: Set<string>, key: string): void {
  keys.add(key);
  pruneMapToMaxSize(keys, MAX_MANAGER_REPLAY_KEYS);
}

/** Append one per-call replay key and retain only the newest bounded suffix. */
export function appendCallReplayKey(keys: string[], key: string): void {
  keys.push(key);
  trimCallReplayKeys(keys);
}

/** Normalize restored or externally constructed call replay history in place. */
export function trimCallReplayKeys(keys: string[]): void {
  const overflow = keys.length - MAX_CALL_REPLAY_KEYS;
  if (overflow > 0) {
    keys.splice(0, overflow);
  }
}
