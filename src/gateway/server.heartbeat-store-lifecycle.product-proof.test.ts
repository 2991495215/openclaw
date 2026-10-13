// Exercise notification ownership through real Gateway reload/replacement and provider HTTP.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { describe, expect, it, vi } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetHeartbeatEventsForTest } from "../infra/heartbeat-events.js";
import { requestHeartbeatAndWait, setHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import * as stateEventSweep from "../sessions/session-state-events.sweep.js";
import { createDeferredCore } from "../shared/deferred.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const WORKER = "OLD-STORE-CHILD";
type Receipt = { status: string; runId: string; childSessionKey: string };
type ProviderRequest = {
  model: string;
  input: Array<{ type?: string; role?: string; call_id?: string; output?: string }>;
};

async function startProvider() {
  const requests: ProviderRequest[] = [];
  const errors: unknown[] = [];
  let notice = createDeferredCore<ProviderRequest>();
  let spawn: Receipt | undefined;
  let spawnRequested = false;
  const server = createServer((request, response) => {
    void (async () => {
      const body = (await json(request)) as ProviderRequest;
      requests.push(body);
      const input = JSON.stringify(body.input);
      const title = input.includes("Generate a concise session title");
      const isNotice = Boolean(
        spawn &&
        input.includes(spawn.childSessionKey) &&
        input.includes("Reconcile before acting:"),
      );
      const output = body.input.find(
        (item) => item.type === "function_call_output" && item.call_id === "call_spawn",
      )?.output;
      if (output) {
        spawn = JSON.parse(output) as Receipt;
      }
      if (!title && !isNotice && !spawnRequested) {
        spawnRequested = true;
        const item = {
          type: "function_call",
          id: "fc_spawn",
          call_id: "call_spawn",
          name: "sessions_spawn",
          arguments: JSON.stringify({
            task: `Return CHILD-DONE. ${WORKER}`,
            visible: true,
            mode: "run",
            expectsCompletionMessage: false,
          }),
        };
        writeOpenAiResponsesSse(response, [
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: 0,
            delta: item.arguments,
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_spawn",
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]);
      } else {
        writeOpenAiResponsesText(response, {
          text: title ? "Store lifecycle proof" : isNotice ? "NO_REPLY" : "CHILD-DONE",
          messageId: `msg_${requests.length}`,
          responseId: `resp_${requests.length}`,
        });
      }
      if (isNotice) {
        notice.resolve(body);
      }
    })().catch((error: unknown) => {
      errors.push(error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    armNoticeObservation() {
      notice = createDeferredCore<ProviderRequest>();
      return notice.promise;
    },
    get spawn() {
      return spawn;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("session notification store ownership through the Gateway", () => {
  it.for(["different store", "same-store replacement"] as const)(
    "handles a queued child notice after %s",
    { timeout: 180_000 },
    async (transition, { signal }) => {
      resetGatewayTestState();
      resetHeartbeatEventsForTest();
      const home = await setupGatewayTempHome({ prefix: "openclaw-heartbeat-store-" });
      let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let stage = "provider-start";
      let replacementRequestOffset: number | undefined;
      let resumedStatus: string | undefined;
      const sweeps: Array<{ stage: string; state: string }> = [];
      const originalSweep = stateEventSweep.sweepSessionStateWatchNotices;
      const sweepSpy = vi
        .spyOn(stateEventSweep, "sweepSessionStateWatchNotices")
        .mockImplementation(async (options) => {
          sweeps.push({ stage, state: "started" });
          try {
            await originalSweep(options);
            sweeps.push({ stage, state: "settled" });
          } catch (error) {
            sweeps.push({ stage, state: "rejected" });
            throw error;
          }
        });
      const reportTimeout = () => {
        console.error(
          "[heartbeat-store-diagnostic]",
          JSON.stringify({
            stage,
            replacementRequestOffset,
            resumedStatus,
            sweeps,
            requests: provider?.requests.map((request) => {
              const input = JSON.stringify(request.input);
              return {
                model: request.model,
                hasChildKey: Boolean(
                  provider?.spawn && input.includes(provider.spawn.childSessionKey),
                ),
                hasReconcileMarker: input.includes("Reconcile before acting:"),
              };
            }),
          }),
        );
      };
      signal.addEventListener("abort", reportTimeout, { once: true });
      await runQaGatewayFixture(
        async () => {
          provider = await startProvider();
          const token = randomUUID();
          setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
          const oldStore = path.join(home.tempHome, "old-store", "sessions.json");
          const newStore = path.join(home.tempHome, "new-store", "sessions.json");
          const cfg: OpenClawConfig = {
            agents: {
              entries: { main: {} },
              defaults: {
                workspace: home.workspaceDir,
                skipBootstrap: true,
                model: "proof/primary",
                heartbeat: { every: "30m" },
                subagents: { allowAgents: ["*"], maxConcurrent: 2 },
                models: Object.fromEntries(
                  ["primary", "backup"].map((model) => [
                    `proof/${model}`,
                    { params: { transport: "sse", openaiWsWarmup: false } },
                  ]),
                ),
              },
            },
            models: {
              mode: "replace",
              providers: {
                proof: {
                  baseUrl: provider.baseUrl,
                  apiKey: "synthetic-key",
                  api: "openai-responses",
                  request: { allowPrivateNetwork: true },
                  models: ["primary", "backup"].map((id) => ({
                    id,
                    name: id,
                    api: "openai-responses",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 4096,
                  })),
                },
              },
            },
            session: { store: oldStore },
            // The provider scripts a direct spawn to isolate notification-store ownership.
            tools: { profile: "coding", toolSearch: false },
            gateway: { auth: { mode: "token", token } },
            hooks: { enabled: false },
          };
          const start = () =>
            startGatewayWithClient({
              cfg,
              configPath,
              token,
              clientName: GATEWAY_CLIENT_NAMES.CLI,
              mode: GATEWAY_CLIENT_MODES.CLI,
              scopes: ["operator.admin"],
            });
          const configPath = await createGatewayConfigPath(home.tempHome);
          stage = "initial-start";
          gateway = await start();
          stage = "initial-startup-settled";
          await gateway.server.startupSettled;
          const parentKey = `agent:main:store-proof-${randomUUID()}`;
          const wait = (runId: string) =>
            gateway!.client.request<{ status: string }>(
              "agent.wait",
              { runId, timeoutMs: 120_000 },
              { timeoutMs: 125_000 },
            );
          stage = "parent-chat-admission";
          const accepted = await gateway.client.request<{ runId: string }>(
            "chat.send",
            {
              sessionKey: parentKey,
              message: "Spawn one worker now.",
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { expectFinal: false },
          );
          stage = "parent-agent-wait";
          const parentResult = await wait(accepted.runId);
          expect(parentResult.status, JSON.stringify(parentResult)).toBe("ok");
          expect(provider.spawn?.status).toBe("accepted");
          const child = provider.spawn;
          if (!child) {
            throw new Error("Parent did not receive sessions_spawn receipt");
          }
          stage = "child-agent-wait";
          expect((await wait(child.runId)).status).toBe("ok");
          stage = "initial-session-list";
          const before = await gateway.client.request<SessionsListResult>("sessions.list", {
            agentId: "main",
            limit: 100,
          });
          const parentSessionId = before.sessions.find(
            (entry) => entry.key === parentKey,
          )?.sessionId;
          expect(parentSessionId).toBeTypeOf("string");
          stage = "child-followup-admission";
          const followup = await gateway.client.request<{ runId: string }>(
            "agent",
            {
              sessionKey: child.childSessionKey,
              message: `Human followup ${WORKER}`,
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { expectFinal: false },
          );
          stage = "child-followup-wait";
          const followupResult = await wait(followup.runId);
          expect(followupResult.status, JSON.stringify(followupResult)).toBe("ok");

          if (transition === "different store") {
            const { hash } = await gateway.client.request<{ hash: string }>("config.get", {});
            await gateway.client.request("config.patch", {
              baseHash: hash,
              raw: JSON.stringify({
                session: { store: newStore },
                agents: { defaults: { model: "proof/backup" } },
              }),
            });
            expect(await gateway.client.request("last-heartbeat", {})).toMatchObject({
              status: "skipped",
              reason: "store-replaced",
            });
            const after = await gateway.client.request<SessionsListResult>("sessions.list", {
              agentId: "main",
              limit: 100,
            });
            expect(after.sessions.map((entry) => entry.key)).not.toContain(parentKey);
            expect(after.sessions.map((entry) => entry.key)).not.toContain(child.childSessionKey);
            expect(provider.requests.map((request) => request.model)).not.toContain("backup");
          } else {
            stage = "replacement-disconnect";
            await disconnectGatewayClient(gateway.client);
            stage = "replacement-close";
            await gateway.server.close({ reason: "same-store replacement" });
            gateway = undefined;
            replacementRequestOffset = provider.requests.length;
            const replacementNotice = provider.armNoticeObservation();
            stage = "replacement-start";
            gateway = await start();
            stage = "replacement-startup-settled";
            await gateway.server.startupSettled;
            // Restart restores unread notices as context for the next ordinary turn.
            stage = "resumed-chat-admission";
            const resumed = await gateway.client.request<{ runId: string }>(
              "chat.send",
              {
                sessionKey: parentKey,
                message: "Continue after the Gateway restart.",
                deliver: false,
                idempotencyKey: randomUUID(),
              },
              { expectFinal: false },
            );
            stage = "resumed-agent-wait";
            const resumedResult = await wait(resumed.runId);
            resumedStatus = resumedResult.status;
            expect(resumedResult.status, JSON.stringify(resumedResult)).toBe("ok");
            stage = "restored-notice";
            const notice = await withinTest(replacementNotice, signal);
            expect(provider.requests.indexOf(notice)).toBeGreaterThanOrEqual(
              replacementRequestOffset,
            );
            expect(notice.model).toBe("primary");
            expect(JSON.stringify(notice.input)).toContain(child.childSessionKey);
            expect(JSON.stringify(notice.input)).toContain(WORKER);
            stage = "replacement-session-list";
            const after = await gateway.client.request<SessionsListResult>("sessions.list", {
              agentId: "main",
              limit: 100,
            });
            expect(after.sessions.find((entry) => entry.key === parentKey)?.sessionId).toBe(
              parentSessionId,
            );
          }
          expect(provider.errors).toEqual([]);
        },
        async () => {
          stage = "cleanup-heartbeat";
          if (!gateway) {
            return;
          }
          setHeartbeatsEnabled(false);
          await requestHeartbeatAndWait({
            source: "manual",
            intent: "immediate",
            reason: "wake",
            coalesceMs: 0,
          });
        },
        () => gateway && disconnectGatewayClient(gateway.client),
        () => {
          stage = "cleanup-gateway-close";
          return gateway?.server.close({ reason: "heartbeat store proof complete" });
        },
        () => provider?.stop(),
        () => resetSubagentRegistryForTests({ persist: false }),
        () => removeGatewayTempHome(home.tempHome),
        () => home.envSnapshot.restore(),
        () => setHeartbeatsEnabled(true),
        resetHeartbeatEventsForTest,
        resetGatewayTestState,
        () => sweepSpy.mockRestore(),
        () => signal.removeEventListener("abort", reportTimeout),
      );
    },
  );
});
