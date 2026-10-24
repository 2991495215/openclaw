const REASONING_CONTENT_REPLAY_MODEL_IDS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "kimi-for-coding",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k3",
  "kimi-k3.1-pro",
  "kimi-k3.1-pro-highspeed",
  "kimi-k2-thinking",
  "kimi-k2-thinking-turbo",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "mimo-v2.6-pro-ultraspeed",
]);

// Access tiers do not change the upstream reasoning_content replay contract (#87575).
const REASONING_CONTENT_REPLAY_TIER_SUFFIXES = ["-free", "-paid", "-trial"] as const;

/** Shared by history sanitization and wire replay, including stale model metadata. */
export function requiresReasoningContentReplay(modelId: unknown): boolean {
  if (typeof modelId !== "string") {
    return false;
  }
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const parts = normalized.split("/").filter(Boolean);
  const finalPart = parts[parts.length - 1] ?? normalized;
  const candidates = [finalPart];
  const colonParts = finalPart.split(":").filter(Boolean);
  if (colonParts.length > 1) {
    candidates.push(colonParts[0] ?? "", colonParts[colonParts.length - 1] ?? "");
  }
  return candidates.some((candidate) => {
    if (REASONING_CONTENT_REPLAY_MODEL_IDS.has(candidate)) {
      return true;
    }
    for (const suffix of REASONING_CONTENT_REPLAY_TIER_SUFFIXES) {
      if (candidate.length > suffix.length && candidate.endsWith(suffix)) {
        return REASONING_CONTENT_REPLAY_MODEL_IDS.has(candidate.slice(0, -suffix.length));
      }
    }
    return REASONING_CONTENT_REPLAY_MODEL_IDS.has(candidate);
  });
}
