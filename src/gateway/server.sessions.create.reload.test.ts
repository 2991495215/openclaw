import { channel } from "node:diagnostics_channel";
import { expect, onTestFinished, test, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import * as chatSession from "./server-methods/chat-send-session.js";
import {
  dashboardTitleScheduleMocks,
  setupSessionCreateTestHarness,
} from "./server.sessions.create.test-support.js";
import { dispatchInboundMessageMock, rpcReq, testState } from "./test-helpers.js";
import { settleGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";
import { getGatewayConfigModule } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness();

test.each([
  { role: "administrator", scopes: ["operator.admin"] },
  { role: "operator", scopes: ["operator.write", "operator.read"] },
])(
  "sessions.create retains its first message across unrelated agent changes for $role",
  async ({ role, scopes }) => {
    const startedAt = Date.now();
    const trace = (stage: string, change = "fixture") =>
      console.error(`[create-reload:${role}:${change}] ${Date.now() - startedAt}ms ${stage}`);
    trace("store.begin");
    const diagnostics = channel("openclaw.session.create");
    const logPhases = (sample: unknown) =>
      console.error(`[create-phases:reload:${role}] ${JSON.stringify(sample)}`);
    diagnostics.subscribe(logPhases);
    onTestFinished(() => {
      diagnostics.unsubscribe(logPhases);
    });
    const { dir, storePath } = await createSessionStoreDir();
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, other: {} } };
    testState.agentConfig = { systemAgent: { agentId: "main" }, sessionStore: { agentId: "main" } };
    trace("client.begin");
    const { ws } = await openClient({ scopes });
    trace("client.ready");
    const config = await getGatewayConfigModule();
    const originalConfig = config.getRuntimeConfig();
    const prepareSession = chatSession.prepareChatSendSession;
    const prepare = vi.spyOn(chatSession, "prepareChatSendSession");
    dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
    try {
      for (const change of ["add", "remove"] as const) {
        const key = `agent:main:dashboard:initial-reload-${change}`;
        const message = `Keep this initial message across unrelated agent ${change}.`;
        const initial = createDeferred();
        const resume = createDeferred();
        const dispatched = createDeferred();
        prepare.mockImplementationOnce(async (options) => {
          trace("session.prepare.begin", change);
          const session = await prepareSession(options);
          trace("session.prepare.done", change);
          initial.resolve();
          await resume.promise;
          trace("session.prepare.resumed", change);
          return session;
        });
        dispatchInboundMessageMock.mockImplementationOnce(async ({ replyOptions }) => {
          trace("dispatch.begin", change);
          await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
          trace("dispatch.persisted", change);
          dispatched.resolve();
          return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
        });
        trace("rpc.sessions.create.begin", change);
        const request = rpcReq<{ key: string; runStarted: boolean }>(ws, "sessions.create", {
          agentId: "main",
          key,
          message,
        }).then(
          (response) => {
            trace(`rpc.sessions.create.response:${response.ok}`, change);
            return response;
          },
          (error: unknown) => {
            trace("rpc.sessions.create.rejected", change);
            throw error;
          },
        );
        try {
          await awaitGateBeforeSettlement(
            initial.promise,
            request.then((response) => {
              throw new Error(`creation skipped its initial turn: ${JSON.stringify(response)}`);
            }),
            "creation skipped its initial turn",
          );
          const current = config.getRuntimeConfig();
          const entries = { ...current.agents?.entries };
          if (change === "add") {
            entries.unrelated = {};
          } else {
            delete entries.unrelated;
          }
          // Publish after chat has captured its routing facts, before initial input admission.
          trace("config.publish.begin", change);
          config.setRuntimeConfigSnapshot({ ...current, agents: { ...current.agents, entries } });
          trace("config.publish.done", change);
          resume.resolve();
          const created = await request;
          expect(created, JSON.stringify(created)).toMatchObject({
            ok: true,
            payload: { key, runStarted: true },
          });
          await dispatched.promise;
          trace("rpc.chat.history.begin", change);
          const history = await rpcReq<{ messages: Array<{ role: string; content: unknown }> }>(
            ws,
            "chat.history",
            { sessionKey: key },
          );
          trace(`rpc.chat.history.response:${history.ok}`, change);
          expect(history.ok, JSON.stringify(history)).toBe(true);
          expect(
            JSON.stringify(history.payload?.messages.find((item) => item.role === "user")),
          ).toContain(message);
        } finally {
          trace("cleanup.begin", change);
          resume.resolve();
          await Promise.allSettled([request]);
          await getSessionWorkAdmissionRelease({ scope: storePath, identities: [key] });
          trace("cleanup.done", change);
        }
      }
    } finally {
      trace("cleanup.config.begin");
      ws.terminate();
      try {
        await settleGatewaySessionStoreFixture(dir);
      } finally {
        // A request can fail before consuming its one-shot dispatch callback.
        dispatchInboundMessageMock.mockReset();
        prepare.mockRestore();
        config.setRuntimeConfigSnapshot(originalConfig);
        trace("cleanup.config.done");
      }
    }
  },
);
