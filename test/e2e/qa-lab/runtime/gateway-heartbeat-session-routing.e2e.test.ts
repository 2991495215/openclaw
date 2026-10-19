import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { retireHeartbeatWithDoctor } from "../../../../src/commands/doctor-heartbeat-retirement.js";
import { getRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { setRuntimeConfigSnapshot } from "../../../../src/config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../../src/config/sessions/session-accessor.js";
import type { LegacyHeartbeatConfig } from "../../../../src/config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { readDefaultProactiveJobReceiptsAsync } from "../../../../src/cron/proactive-job-receipt.js";
import { readSessionMessagesAsync } from "../../../../src/gateway/session-transcript-readers.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import { peekSystemEvents } from "../../../../src/infra/system-events.js";
import { normalizeSessionDeliveryState } from "../../../../src/utils/delivery-context.shared.js";
import {
  listenLoopback,
  readRequestText,
  closeHttpServer,
} from "../../../helpers/gateway-integration-fixtures.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { writeFixtureReply } from "./gateway-recovery.test-support.js";
import { prepareRecoveryHome, resetGatewayState } from "./gateway-startup-routing.test-support.js";

const PROOF_CHANNEL_ID = "heartbeat-route-proof";

type DeliveryTrace = {
  accountId: string | null;
  text: string;
  threadId: string | number | null;
  to: string;
};

let sequence = 0;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function nextId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${sequence++}`;
}

async function writeRouteCapturePlugin(params: {
  pluginDir: string;
  tracePath: string;
  cronReadyEvent: string;
}): Promise<void> {
  await fs.mkdir(params.pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(params.pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PROOF_CHANNEL_ID,
      activation: { onStartup: true },
      channels: [PROOF_CHANNEL_ID],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(params.pluginDir, "index.cjs"),
    [
      'const fs = require("node:fs");',
      "let sequence = 0;",
      "module.exports = {",
      `  id: ${JSON.stringify(PROOF_CHANNEL_ID)},`,
      "  register(api) {",
      `    process.emit(${JSON.stringify(`${params.cronReadyEvent}-registered`)}, { pid: process.pid });`,
      '    api.on("cron_reconciled", (event) => {',
      `      process.emit(${JSON.stringify(params.cronReadyEvent)}, event);`,
      "    });",
      "    api.registerChannel({",
      "      plugin: {",
      `        id: ${JSON.stringify(PROOF_CHANNEL_ID)},`,
      "        meta: {",
      `          id: ${JSON.stringify(PROOF_CHANNEL_ID)},`,
      '          label: "Heartbeat Route Proof",',
      '          selectionLabel: "Heartbeat Route Proof",',
      '          docsPath: "/channels/heartbeat-route-proof",',
      '          blurb: "Captures heartbeat routes for Gateway boundary tests.",',
      "        },",
      '        capabilities: { chatTypes: ["direct"] },',
      "        config: {",
      '          listAccountIds: () => ["default"],',
      '          resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),',
      "          isEnabled: () => true,",
      "          isConfigured: () => true,",
      "        },",
      "        outbound: {",
      '          deliveryMode: "direct",',
      "          sendText: async ({ to, text, accountId, threadId }) => {",
      `            fs.appendFileSync(${JSON.stringify(params.tracePath)}, JSON.stringify({`,
      "              to,",
      "              text,",
      "              accountId: accountId ?? null,",
      "              threadId: threadId ?? null,",
      '            }) + "\\n", "utf8");',
      "            sequence += 1;",
      `            return { channel: ${JSON.stringify(PROOF_CHANNEL_ID)}, messageId: \`proof-\${sequence}\` };`,
      "          },",
      "        },",
      "      },",
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function readDeliveryTrace(filePath: string): Promise<DeliveryTrace[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DeliveryTrace);
}

async function readSessionTranscript(sessionKey: string): Promise<unknown[]> {
  const entry = loadSessionEntry({ agentId: "main", sessionKey, readConsistency: "latest" });
  if (!entry?.sessionId) {
    throw new Error(`Session entry ${sessionKey} was not persisted`);
  }
  return await readSessionMessagesAsync(
    {
      agentId: "main",
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey,
    },
    { mode: "full", reason: "heartbeat session routing Gateway boundary proof" },
  );
}

const poll = <T>(read: () => T) => expect.poll(read, { timeout: 15_000, interval: 50 });
const transcript = (key: string) => readSessionTranscript(key).then(JSON.stringify);
const readSessionId = (sessionKey: string) =>
  loadSessionEntry({ agentId: "main", sessionKey, readConsistency: "latest" })?.sessionId;

describe("Gateway heartbeat session routing", () => {
  let fixtureSettlement: Promise<void> | undefined;
  beforeEach(resetGatewayState);
  afterEach(async () => {
    // A timed-out body still owns Gateway shutdown. Join it before outer hooks
    // reset runtime state or remove the fixture's files.
    await fixtureSettlement;
    fixtureSettlement = undefined;
    resetGatewayState();
  });

  it(
    "migrates monitor session routing while preserving explicit wake sessions and passive notices",
    { timeout: 90_000 },
    async ({ signal }) => {
      const tempHome = tempDirs.make("openclaw-gateway-heartbeat-routing-");
      const token = nextId("heartbeat-routing-token");
      const { workspaceDir, configPath, envSnapshot } = await prepareRecoveryHome(
        tempHome,
        token,
        true,
      );
      const pluginDir = path.join(workspaceDir, "plugins", PROOF_CHANNEL_ID);
      const deliveryTracePath = path.join(tempHome, "heartbeat-deliveries.jsonl");
      const cronReadyEvent = nextId("cron-reconciled");
      const startedAt = Date.now();
      let phase = "fixture-setup";
      let cleanupPhase: string | undefined;
      const phases = [{ phase, elapsedMs: 0 }];
      const markPhase = (next: string) => {
        phase = next;
        phases.push({ phase, elapsedMs: Date.now() - startedAt });
      };
      const cronRegistrations: Array<{ phase: string; elapsedMs: number; event: unknown }> = [];
      const cronEvents: Array<{ phase: string; elapsedMs: number; event: unknown }> = [];
      const onCronRegistered = (event: unknown) => {
        cronRegistrations.push({ phase, elapsedMs: Date.now() - startedAt, event });
      };
      const cronReconciled = createDeferred<unknown>();
      const onCronReconciled = (event: unknown) => {
        cronEvents.push({ phase, elapsedMs: Date.now() - startedAt, event });
        cronReconciled.resolve(event);
      };
      await Promise.all([
        fs.writeFile(
          path.join(workspaceDir, "HEARTBEAT.md"),
          "Process all pending system events and report what was handled.\n",
        ),
        writeRouteCapturePlugin({ pluginDir, tracePath: deliveryTracePath, cronReadyEvent }),
      ]);

      const configuredSessionKey = "agent:main:ops-heartbeat";
      const configuredSessionId = nextId("configured-heartbeat-session");
      const configuredEvent = nextId("configured-heartbeat-event");
      const configuredPrompt = nextId("configured-monitor-prompt");
      const configuredReply = nextId("configured-heartbeat-reply");
      const explicitSessionKey = "agent:main:user-session";
      const explicitSessionId = nextId("explicit-heartbeat-session");
      const explicitQueuedEvent = nextId("explicit-queued-event");
      const explicitWakeText = nextId("explicit-wake-event");
      const explicitReply = nextId("explicit-heartbeat-reply");
      const mainSessionKey = "agent:main:main";
      const mainSessionId = nextId("main-session");
      const providerRequests: Array<Record<string, unknown>> = [];
      const providerServer = createServer((request, response) => {
        void (async () => {
          const raw = await readRequestText(request);
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const body = JSON.parse(raw) as Record<string, unknown>;
          providerRequests.push(body);
          const serialized = JSON.stringify(body);
          writeFixtureReply(
            response,
            serialized.includes(configuredPrompt)
              ? configuredReply
              : serialized.includes(explicitQueuedEvent) || serialized.includes(explicitWakeText)
                ? explicitReply
                : nextId("unexpected-heartbeat-reply"),
            nextId("provider-message"),
            nextId("provider-response"),
          );
        })().catch((error: unknown) => {
          response.writeHead(500).end(error instanceof Error ? error.message : String(error));
        });
      });

      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      onTestFailed(() => {
        process.stderr.write(
          `[heartbeat-routing-failure] ${JSON.stringify({
            phase,
            cleanupPhase,
            phases,
            cronRegistrations,
            cronEvents,
            providerRequests: providerRequests.length,
          })}\n`,
        );
      });
      const fixtureSettled = createDeferred();
      fixtureSettlement = fixtureSettled.promise;
      try {
        process.on(cronReadyEvent, onCronReconciled);
        process.on(`${cronReadyEvent}-registered`, onCronRegistered);
        const providerUrl = await listenLoopback(providerServer);
        const provider = buildMockOpenAiResponsesProvider(
          `${providerUrl}/v1`,
          "gpt-heartbeat-session-routing",
        );
        const legacyConfig = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              heartbeat: {
                every: "24h",
                session: "ops-heartbeat",
                target: "last",
                prompt: configuredPrompt,
              },
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
                "catalog-proof/*": {},
              },
            },
            entries: { main: {} },
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: {
                ...provider.config,
                models: provider.config.models.map((model) =>
                  Object.assign({}, model, { input: Array.from(model.input) }),
                ),
              },
            },
          },
          // Full configs may contain nested nulls; session admission must not reinterpret them as patches.
          tts: { providers: { fixture: { disabledVoice: null } } },
          gateway: { auth: { mode: "token", token } },
          plugins: {
            enabled: true,
            allow: [PROOF_CHANNEL_ID],
            load: { paths: [pluginDir] },
            entries: { [PROOF_CHANNEL_ID]: { enabled: true } },
            slots: { memory: "none" },
          },
        } satisfies OpenClawConfig & {
          agents: { defaults: { heartbeat: LegacyHeartbeatConfig } };
        };

        // Persist legacy routes before the Gateway captures database creation ownership.
        setRuntimeConfigSnapshot(legacyConfig);
        const seedSession = async (sessionId: string, sessionKey: string, to: string) => {
          await replaceSessionEntry(
            { agentId: "main", sessionKey },
            {
              sessionId,
              updatedAt: Date.now(),
              delivery: normalizeSessionDeliveryState({
                context: { channel: PROOF_CHANNEL_ID, to, accountId: "default" },
              }),
            },
          );
        };
        await seedSession(configuredSessionId, configuredSessionKey, "configured-destination");
        await seedSession(explicitSessionId, explicitSessionKey, "explicit-destination");
        await seedSession(mainSessionId, mainSessionKey, "main-destination");

        markPhase("doctor.retire");
        const config = await retireHeartbeatWithDoctor(legacyConfig);
        expect(config.agents?.defaults).not.toHaveProperty("heartbeat");
        const receipt = (await readDefaultProactiveJobReceiptsAsync(undefined, ["main"])).main;
        expect(receipt).toMatchObject({ phase: "complete", jobId: expect.any(String) });

        markPhase("gateway.start:first");
        gateway = await startGatewayWithClient({
          cfg: config,
          configPath,
          token,
          clientDisplayName: "vitest-gateway-heartbeat-session-routing",
        });
        markPhase("gateway.startupSettled:first");
        await gateway.server.startupSettled;
        markPhase("gateway.disconnect:first");
        await disconnectGatewayClient(gateway.client);
        markPhase("gateway.close:first");
        await gateway.server.close({ reason: "heartbeat catalog-owner restart proof" });
        markPhase("gateway.start:restart");
        gateway = await startGatewayWithClient({
          cfg: config,
          configPath,
          token,
          clientDisplayName: "vitest-gateway-heartbeat-session-routing-restarted",
        });
        markPhase("gateway.startupSettled:restart");
        await gateway.server.startupSettled;
        const runtimeConfig = getRuntimeConfigSnapshot();
        if (!runtimeConfig) {
          throw new Error("gateway runtime config snapshot was not initialized");
        }
        const client = gateway.client;
        const queueEvent = async (sessionKey: string, text: string) => {
          await expect(
            client.request("system-event", { text, sessionKey, wake: false }),
          ).resolves.toEqual({ ok: true });
          expect(peekSystemEvents(sessionKey)).toContain(text);
        };

        markPhase("system-event:configured");
        await queueEvent(configuredSessionKey, configuredEvent);

        // A connected Gateway may still be starting cron; its lifecycle hook owns readiness.
        markPhase("cron-reconciled:wait");
        expect(await withinTest(cronReconciled.promise, signal)).toEqual({
          reason: "startup",
          enabled: true,
        });
        markPhase("cron.list");
        const listed = await client.request<{
          jobs: Array<{
            agentId?: string;
            declarationKey?: string;
            enabled: boolean;
            id: string;
            payload: { kind: string };
            sessionTarget: string;
          }>;
        }>("cron.list", { includeDisabled: true });
        const monitor = listed.jobs.find((job) => job.id === receipt?.jobId);
        expect(monitor).toMatchObject({
          agentId: "main",
          enabled: true,
          payload: { kind: "agentTurn" },
          sessionTarget: `session:${configuredSessionKey}`,
        });
        if (!monitor) {
          throw new Error("migrated main-agent automation was not listed");
        }

        expect(monitor).not.toHaveProperty("declarationKey");
        const configuredRequestBaseline = providerRequests.length;
        markPhase("cron.run");
        const configuredRun = await client.request<{
          enqueued: boolean;
          ok: boolean;
          runId: string;
        }>("cron.run", {
          id: monitor.id,
          mode: "force",
        });
        expect(configuredRun).toMatchObject({
          ok: true,
          enqueued: true,
          runId: expect.any(String),
        });
        markPhase("cron.runs:configured");
        await poll(async () => {
          const history = await client.request<{
            entries: Array<{ error?: string; runId?: string; status?: string }>;
          }>("cron.runs", {
            id: monitor.id,
            runId: configuredRun.runId,
            limit: 1,
          });
          return history.entries.find((entry) => entry.runId === configuredRun.runId);
        }).toMatchObject({ runId: configuredRun.runId, status: "ok" });
        markPhase("provider:configured");
        await poll(() => providerRequests.length).toBeGreaterThan(configuredRequestBaseline);
        const configuredRequest = JSON.stringify(providerRequests[configuredRequestBaseline]);
        expect(configuredRequest).toContain(configuredPrompt);
        expect(configuredRequest).not.toContain(configuredEvent);
        expect(peekSystemEvents(configuredSessionKey)).toContain(configuredEvent);
        const delivery = (text: string, to: string) => ({
          accountId: "default",
          text,
          threadId: null,
          to,
        });
        const configuredDelivery = delivery(configuredReply, "configured-destination");
        markPhase("delivery:configured");
        await poll(() => readDeliveryTrace(deliveryTracePath)).toHaveLength(1);
        expect(await readDeliveryTrace(deliveryTracePath)).toEqual([configuredDelivery]);
        markPhase("transcript:configured");
        await poll(() => transcript(configuredSessionKey)).toContain(configuredReply);
        expect(readSessionId(configuredSessionKey)).toBe(configuredSessionId);
        expect(await transcript(mainSessionKey)).not.toContain(configuredReply);

        markPhase("system-event:explicit");
        await queueEvent(explicitSessionKey, explicitQueuedEvent);
        const explicitRequestBaseline = providerRequests.length;
        markPhase("wake:explicit");
        await expect(
          client.request<{ ok: boolean }>("wake", {
            mode: "now",
            text: explicitWakeText,
            agentId: "main",
            sessionKey: explicitSessionKey,
          }),
        ).resolves.toEqual({ ok: true });
        markPhase("provider:explicit");
        await poll(() => providerRequests.length).toBeGreaterThan(explicitRequestBaseline);
        const explicitRequest = JSON.stringify(providerRequests[explicitRequestBaseline]);
        expect(explicitRequest).not.toContain(explicitQueuedEvent);
        expect(explicitRequest).toContain(explicitWakeText);
        expect(peekSystemEvents(explicitSessionKey)).toContain(explicitQueuedEvent);
        markPhase("delivery:explicit");
        await poll(() => readDeliveryTrace(deliveryTracePath)).toHaveLength(2);
        expect(await readDeliveryTrace(deliveryTracePath)).toEqual([
          configuredDelivery,
          delivery(explicitReply, "explicit-destination"),
        ]);
        markPhase("transcript:explicit");
        await poll(() => transcript(explicitSessionKey)).toContain(explicitReply);
        expect(readSessionId(explicitSessionKey)).toBe(explicitSessionId);
        expect(peekSystemEvents(explicitSessionKey)).toContain(explicitQueuedEvent);
        expect(peekSystemEvents(explicitSessionKey)).not.toContain(explicitWakeText);
        markPhase("transcript:final");
        const explicitTranscript = await transcript(explicitSessionKey);
        expect(explicitTranscript).toContain(explicitReply);
        expect(explicitTranscript).not.toContain(configuredReply);
        expect(await transcript(configuredSessionKey)).not.toContain(explicitReply);
        const mainTranscript = await transcript(mainSessionKey);
        expect(mainTranscript).not.toContain(configuredReply);
        expect(mainTranscript).not.toContain(explicitReply);
        expect((await readDeliveryTrace(deliveryTracePath)).map((entry) => entry.to)).not.toContain(
          "main-destination",
        );
      } finally {
        process.removeListener(cronReadyEvent, onCronReconciled);
        process.removeListener(`${cronReadyEvent}-registered`, onCronRegistered);
        try {
          if (gateway) {
            cleanupPhase = "client.disconnect";
            await disconnectGatewayClient(gateway.client);
            cleanupPhase = "gateway.close";
            await gateway.server.close({
              reason: "Gateway heartbeat session routing test complete",
            });
          }
          cleanupPhase = "provider.close";
          await closeHttpServer(providerServer);
          cleanupPhase = "env.restore";
          envSnapshot.restore();
        } finally {
          cleanupPhase = "settled";
          fixtureSettled.resolve();
        }
      }
    },
  );
});
