import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { json } from "node:stream/consumers";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { readSessionEntryReadOnlyInWorker } from "../src/config/sessions/session-entry-read-runtime.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const sessionKey = "agent:main:requested-compaction-proof";
const summary =
  "## Goal\nFinish the pending migration.\n\n## Progress\nThe earlier substantial step is complete.\n\n## Decisions\nKeep COMPACTION-CONTINUITY-427.\n\n## Next Steps\nAnswer the remaining request without replaying completed tools.";

// Real Gateway, model transport, tool dispatch, maintenance owner and SQLite writer.
// The deterministic provider proves behavior, not paid-provider cache acceptance or savings.
it.each([
  { enabled: true, rejectSummary: false },
  { enabled: false, rejectSummary: false },
  { enabled: true, rejectSummary: true },
])(
  "model-requested compaction precedes the next step without replay (enabled=$enabled, reject=$rejectSummary)",
  { timeout: 240_000 },
  async ({ enabled, rejectSummary }) => {
    const requests: string[] = [];
    let requested = false;
    let summaryCalls = 0;
    let toolVisible = false;
    let artifactPath = "";
    let nextStepRequested = false;
    let requestFinalEmitted = false;
    let continuationInput = "";
    let completedNextStep = false;
    const events: string[] = [];
    const summaryInputs: string[] = [];
    const modelServer = await startOpenAiResponsesModelServer({
      modelId: "compaction-proof",
      bindError: "compaction proof provider did not bind",
      onRequest: async (request, response) => {
        const body: unknown = await json(request);
        if (!isRecord(body)) {
          throw new Error("expected model request");
        }
        const encoded = JSON.stringify(body);
        requests.push(encoded);
        const sequence = requests.length;
        if (encoded.includes("You are a context summarization assistant")) {
          summaryCalls += 1;
          events.push("compaction");
          summaryInputs.push(encoded);
          if (rejectSummary) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: { type: "invalid_request_error", message: "Synthetic summary refused" },
              }),
            );
            return;
          }
          writeOpenAiResponsesText(response, {
            text: summary,
            messageId: `msg_summary_${sequence}`,
            responseId: `resp_summary_${sequence}`,
          });
          return;
        }
        const hasTool =
          Array.isArray(body.tools) &&
          body.tools.some((tool: unknown) => isRecord(tool) && tool.name === "session_compact");
        toolVisible ||= hasTool;
        let calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
        if (hasTool && encoded.includes("REQUEST_COMPACTION_NOW") && !requested) {
          requested = true;
          events.push("completed_step_batch");
          calls = [
            {
              id: "finished_step",
              name: "exec",
              args: {
                command: "printf 'completed-action-427\\n' >> " + JSON.stringify(artifactPath),
                yieldMs: 10000,
              },
            },
            {
              id: "compact",
              name: "session_compact",
              args: { focus: "Preserve the pending migration and COMPACTION-CONTINUITY-427" },
            },
          ];
        } else if (requested && !nextStepRequested) {
          nextStepRequested = true;
          continuationInput = encoded;
          events.push("next_step");
          calls = [
            { id: "next_step", name: "read", args: { path: artifactPath } },
            { id: "compact_again", name: "session_compact", args: {} },
          ];
        } else if (nextStepRequested && !requestFinalEmitted) {
          requestFinalEmitted = true;
          completedNextStep =
            Array.isArray(body.input) &&
            body.input.some(
              (item: unknown) =>
                isRecord(item) &&
                item.type === "function_call_output" &&
                item.call_id === "call_next_step" &&
                JSON.stringify(item.output).includes("completed-action-427"),
            );
          events.push("final_reply");
        }
        if (calls.length) {
          const output = calls.map(({ id, name, args }) => ({
            type: "function_call",
            id: "fc_" + id,
            call_id: "call_" + id,
            name,
            arguments: JSON.stringify(args),
            status: "completed",
          }));
          writeOpenAiResponsesSse(response, [
            ...output.flatMap((item, output_index) => [
              {
                type: "response.output_item.added",
                output_index,
                item: { ...item, arguments: "" },
              },
              { type: "response.output_item.done", output_index, item },
            ]),
            {
              type: "response.completed",
              response: {
                id: "resp_tool_" + sequence,
                status: "completed",
                output,
                usage: { input_tokens: 1000, output_tokens: 30, total_tokens: 1030 },
              },
            },
          ]);
          return;
        }
        writeOpenAiResponsesText(response, {
          text: "The substantial step is complete; the migration remains pending.",
          messageId: `msg_${sequence}`,
          responseId: `resp_${sequence}`,
        });
      },
    });
    const config = createOpenAiResponsesModelConfig({
      baseUrl: modelServer.baseUrl,
      providerId: "compaction-proof",
      modelId: "compaction-proof",
      reasoning: false,
      toolProfile: "minimal",
    });
    config.plugins = {
      ...config.plugins,
      allow: ["session-compaction"],
      entries: { "session-compaction": { enabled: true } },
    };
    config.tools = {
      ...config.tools,
      codeMode: false,
      toolSearch: false,
      alsoAllow: ["session_compact", "exec", "read"],
      exec: { host: "gateway", mode: "full" },
    };
    config.agents = {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        compaction: {
          enabled,
          mode: "default",
          keepRecentTokens: 64,
          memoryFlush: { enabled: false },
        },
      },
    };
    const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
      .filter(Boolean)
      .join(",");
    const instance = await createOpenClawTestInstance({
      name: `requested-compaction-${enabled}`,
      config,
      gatewayArgs: ["--profile", `requested-compaction-${enabled}`],
      env: {
        OPENCLAW_PROFILE: `requested-compaction-${enabled}`,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    artifactPath = path.join(instance.state.workspaceDir, "finished-step.txt");
    try {
      await instance.startGateway();
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      try {
        const turn = async (message: string) => {
          const before = requests.length;
          const result = await client
            .request<{ status?: string }>(
              "agent",
              { sessionKey, message, deliver: false, idempotencyKey: randomUUID() },
              { expectFinal: true, timeoutMs: 120_000 },
            )
            .catch((error: unknown) => {
              throw new Error(
                "Gateway turn failed; provider requests observed: " + requests.length,
                { cause: error },
              );
            });
          expect(result.status).toBe("ok");
          if (requests.length === before) {
            throw new Error(
              `Gateway reported completion without a provider request: ${JSON.stringify(result)}\n${instance.logs()}`,
            );
          }
        };
        await turn(
          "Earlier topic: COMPACTION-CONTINUITY-427. Keep the migration pending. " +
            "Completed implementation detail. ".repeat(250),
        );
        await turn(
          "REQUEST_COMPACTION_NOW: a substantial step is finished, but keep the unresolved migration.",
        );
        expect(toolVisible).toBe(enabled);
        const readEntry = () =>
          readSessionEntryReadOnlyInWorker({
            agentId: "main",
            sessionKey,
            storePath: path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite"),
            env: instance.state.env,
          });
        if (enabled) {
          await expect
            .poll(async () => (await readEntry())?.compactionCount ?? 0, {
              timeout: 30_000,
              interval: 100,
            })
            .toBe(rejectSummary ? 0 : 1);
          expect(summaryCalls).toBeGreaterThan(0);
          expect(events.indexOf("compaction")).toBeGreaterThan(
            events.indexOf("completed_step_batch"),
          );
          expect(events.indexOf("compaction")).toBeLessThan(events.indexOf("next_step"));
          expect(events.lastIndexOf("compaction")).toBeLessThan(events.indexOf("final_reply"));
          expect(continuationInput).toContain(
            rejectSummary ? "Completed implementation detail." : "## Goal",
          );
          expect(continuationInput).toContain("REQUEST_COMPACTION_NOW");
          expect(
            summaryInputs.some((body) => body.includes("Completed implementation detail.")),
          ).toBe(true);
          expect(
            summaryInputs.some((body) => body.includes("Preserve the pending migration")),
          ).toBe(true);
          expect(await fs.readFile(artifactPath, "utf8")).toBe("completed-action-427\n");
          expect(completedNextStep).toBe(true);
        } else {
          expect((await readEntry())?.compactionCount ?? 0).toBe(0);
          expect(summaryCalls).toBe(0);
        }
        const before = requests.length;
        await turn("Continue the remaining request.");
        expect(requests.length).toBe(before + 1);
        expect(requests.at(-1)).toContain("COMPACTION-CONTINUITY-427");
        if (enabled) {
          expect(requests.at(-1)).toContain(
            rejectSummary ? "Completed implementation detail." : "## Goal",
          );
          expect((await readEntry())?.compactionCount ?? 0).toBe(rejectSummary ? 0 : 1);
        }
      } catch (error) {
        throw new Error(
          `Boundary proof failed: ${JSON.stringify({ events, summaryCalls, completedNextStep })}\n${instance.logs()}`,
          { cause: error },
        );
      } finally {
        await disconnectGatewayClient(client);
      }
    } finally {
      await instance.cleanup();
      await modelServer.close();
    }
  },
);
