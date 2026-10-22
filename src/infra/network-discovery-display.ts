import type { GatewayBindMode } from "../config/types.js";
import { pickPrimaryLanIPv4, resolveGatewayBindHost } from "../gateway/net.js";
import { pickPrimaryTailnetIPv4 } from "./tailnet.js";

// Display helpers are best-effort wrappers around network discovery. Startup
// and config output should keep rendering even when interface probes fail.
function fallbackBindHostForDisplay(bindMode: GatewayBindMode, customBindHost?: string): string {
  if (bindMode === "lan") {
    return "0.0.0.0";
  }
  if (bindMode === "custom") {
    return customBindHost?.trim() || "0.0.0.0";
  }
  return "127.0.0.1";
}

/** Return a LAN IPv4 for display, or undefined when interface discovery fails. */
export function pickBestEffortPrimaryLanIPv4(): string | undefined {
  try {
    return pickPrimaryLanIPv4();
  } catch {
    return undefined;
  }
}

/** Return a tailnet IPv4 for display, or undefined when interface discovery fails. */
export function inspectBestEffortPrimaryTailnetIPv4(): {
  tailnetIPv4: string | undefined;
} {
  try {
    return { tailnetIPv4: pickPrimaryTailnetIPv4() };
  } catch {
    return { tailnetIPv4: undefined };
  }
}

/** Resolve the gateway bind host for display, falling back to a safe placeholder. */
export async function resolveBestEffortGatewayBindHostForDisplay(params: {
  bindMode: GatewayBindMode;
  customBindHost?: string;
}): Promise<{ bindHost: string; warning?: string }> {
  try {
    return {
      bindHost: await resolveGatewayBindHost(params.bindMode, params.customBindHost),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : "";
    return {
      bindHost: fallbackBindHostForDisplay(params.bindMode, params.customBindHost),
      warning: `Status is using fallback network details because interface discovery failed: ${
        message || "network interface discovery failed"
      }.`,
    };
  }
}
