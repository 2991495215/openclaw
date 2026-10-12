// HOLD / neverLand: opt-in phase markers for the synthetic Codex recovery fixture.
export function tracePluginCleanupPhase(
  phase: string,
  pluginId?: string,
  serviceId?: string,
): void {
  if (!process.env.VITEST || process.env.OPENCLAW_TEST_CODEX_RECOVERY_CLEANUP_TRACE !== "1") {
    return;
  }
  const label = (value?: string) => value?.replace(/[^A-Za-z0-9_.:/-]/gu, "_").slice(0, 120);
  console.error("[codex-recovery-cleanup]", {
    phase: label(phase),
    pluginId: label(pluginId),
    serviceId: label(serviceId),
  });
}
