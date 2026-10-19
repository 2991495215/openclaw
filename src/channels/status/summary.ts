// Async-capable adapter return contexts must not infer Promise-valued plugin extras.
type BaseChannelStatusSummary<TExtra extends object> = {
  configured: boolean;
} & TExtra & {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
  };

/** Normalize a channel-level status summary so missing lifecycle fields become explicit nulls. */
export function buildBaseChannelStatusSummary<TExtra extends object>(
  snapshot: {
    configured?: boolean | null;
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    probe?: unknown;
    lastProbeAt?: number | null;
  },
  extra?: TExtra,
): NoInfer<BaseChannelStatusSummary<TExtra>> {
  // Channel summaries already consume projected account state; this helper only normalizes nulls.
  return {
    configured: snapshot.configured ?? false,
    // SAFETY: Only the empty spread fallback is asserted; no fallback fields are read.
    ...(extra ?? ({} as TExtra)),
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
  };
}

/** Extend the base summary with probe fields while preserving stable null defaults. */
export function buildProbeChannelStatusSummary<TExtra extends object>(
  snapshot: Parameters<typeof buildBaseChannelStatusSummary>[0],
  extra?: TExtra,
): NoInfer<BaseChannelStatusSummary<TExtra> & { probe: unknown; lastProbeAt: number | null }> {
  return {
    ...buildBaseChannelStatusSummary(snapshot, extra),
    probe: snapshot.probe,
    lastProbeAt: snapshot.lastProbeAt ?? null,
  };
}
