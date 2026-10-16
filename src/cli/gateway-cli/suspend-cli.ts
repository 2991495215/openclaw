import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  GatewaySuspendPrepareResult,
  GatewaySuspendResumeResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { colorize, isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { callGatewayFromCliWithTransport } from "../gateway-rpc.js";

type SuspendRpcOpts = Parameters<typeof callGatewayFromCliWithTransport>[1];

const MIN_SUSPEND_POLL_DELAY_MS = 50;

function parseWaitMs(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = typeof value === "number" ? value : Number(value.trim() || Number.NaN);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("--wait must be a non-negative number of seconds");
  }
  const milliseconds = Math.floor(seconds * 1_000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("--wait is too large");
  }
  return milliseconds;
}

function resolveRequestId(value: string | undefined): string {
  if (value === undefined) {
    return `cli-${randomBytes(4).toString("hex")}`;
  }
  const requestId = value.trim();
  if (!requestId || requestId.length > 128) {
    throw new Error("--request-id must contain 1 to 128 characters");
  }
  return requestId;
}

function formatBusyResult(
  result: Extract<GatewaySuspendPrepareResult, { status: "busy" }>,
): string {
  const blockers = result.blockers.map((blocker) => `- ${blocker.message}`);
  return [
    `Gateway suspension is busy (${result.reason}; ${result.activeCount} active).`,
    ...(blockers.length > 0 ? ["Blockers:", ...blockers] : []),
  ].join("\n");
}

export async function runGatewaySuspend(options: {
  rpcOpts: SuspendRpcOpts;
  requestId?: string;
  waitSeconds?: string | number;
  json?: boolean;
}): Promise<void> {
  const requestId = resolveRequestId(options.requestId);
  const waitMs = parseWaitMs(options.waitSeconds);
  const deadlineMs = waitMs === undefined ? undefined : Date.now() + waitMs;
  const maxAttempts = waitMs === undefined ? 1 : Math.ceil(waitMs / MIN_SUSPEND_POLL_DELAY_MS) + 1;
  let latest: GatewaySuspendPrepareResult | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // A sleep can overshoot the deadline; never issue a prepare that could
    // suspend the Gateway after the operator's advertised --wait window.
    if (attempt > 0 && deadlineMs !== undefined && Date.now() >= deadlineMs) {
      break;
    }
    latest = await callGatewayFromCliWithTransport<GatewaySuspendPrepareResult>(
      "gateway.suspend.prepare",
      options.rpcOpts,
      { requestId },
      { defaultTimeoutMs: 10_000, sharedStateMode: "read-only" },
    );
    if (latest.status === "ready") {
      if (options.json) {
        defaultRuntime.writeJson({ ...latest, requestId });
        return;
      }
      const rich = isRich();
      defaultRuntime.log(colorize(rich, theme.success, "Gateway suspension prepared."));
      defaultRuntime.log(`${colorize(rich, theme.muted, "Suspension ID:")} ${latest.suspensionId}`);
      defaultRuntime.log(
        `${colorize(rich, theme.muted, "Expires:")} ${new Date(latest.expiresAtMs).toISOString()} (${latest.expiresAtMs} ms)`,
      );
      const port = options.rpcOpts.localPortOverride;
      const command = `openclaw gateway resume ${latest.suspensionId}`;
      defaultRuntime.log(
        `Resume with: ${formatCliCommand(port === undefined ? command : `${command} --port ${port}`)}`,
      );
      return;
    }
    if (latest.status === "draining") {
      throw new Error("Gateway suspension unexpectedly entered drain mode");
    }

    if (deadlineMs === undefined) {
      break;
    }

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    const delayMs = Math.min(remainingMs, Math.max(MIN_SUSPEND_POLL_DELAY_MS, latest.retryAfterMs));
    await sleep(delayMs);
  }

  if (!latest || latest.status !== "busy") {
    throw new Error("Gateway suspension polling ended without a result");
  }
  if (options.json) {
    defaultRuntime.writeJson({ ...latest, requestId });
    defaultRuntime.exit(1);
    return;
  }
  const hint =
    deadlineMs === undefined
      ? "Retry later or use --wait <seconds>."
      : "Timed out waiting for the Gateway to become idle.";
  throw new Error(`${formatBusyResult(latest)}\n${hint}`);
}

export async function runGatewayResume(options: {
  rpcOpts: SuspendRpcOpts;
  suspensionId: string;
  json?: boolean;
}): Promise<void> {
  const result = await callGatewayFromCliWithTransport<GatewaySuspendResumeResult>(
    "gateway.suspend.resume",
    options.rpcOpts,
    { suspensionId: options.suspensionId },
    { defaultTimeoutMs: 10_000, sharedStateMode: "read-only" },
  );
  if (options.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(
    result.resumed
      ? "Gateway resumed."
      : "No matching suspension was held (lease already expired or resumed); gateway is running.",
  );
}
