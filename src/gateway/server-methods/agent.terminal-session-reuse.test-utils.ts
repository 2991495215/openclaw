// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import fs from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  getAgentTestMocks,
  type AgentParams,
  setDateOnlyFakeClockActive,
  expectSqliteSessionFileMarkerForEntry,
  mockSuccessfulAgentCommand,
  runMainAgent,
  waitForAgentCommandCall,
  invokeAgent,
  describe0AfterEach0,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-gateway-terminal-reuse-");
  afterEach(describe0AfterEach0);

  it("reuses terminal main sessions when the fresh store row has the transcript marker", async () => {
    const now = Date.parse("2026-05-18T09:47:30.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);

    const root = sessionDirs.make();
    const sessionsDir = `${root}/sessions`;
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = "terminal-main-session.jsonl";
    const transcriptPath = `${sessionsDir}/${sessionFile}`;
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
      "utf8",
    );
    await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
    const staleEntry = {
      sessionId: "terminal-main-session",
      sessionFile,
      status: "done",
      updatedAt: now - 10_000,
      cliSessionBindings: {
        "claude-cli": { sessionId: "existing-claude-cli-session" },
      },
      cliSessionIds: {
        "claude-cli": "existing-claude-cli-session",
      },
      claudeCliSessionId: "existing-claude-cli-session",
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: `${sessionsDir}/sessions.json`,
      entry: staleEntry,
      canonicalKey: "agent:main:main",
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store = {
        "agent:main:main": {
          ...staleEntry,
          updatedAt: now,
        },
      };
      const result = await updater(store);
      capturedEntry = result as Record<string, unknown>;
      return result;
    });
    mockSuccessfulAgentCommand();

    await runMainAgent("hi", "test-idem-terminal-main-fresh-marker");

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).toBe("terminal-main-session");
    expect(capturedEntry?.sessionId).toBe("terminal-main-session");
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
    expect(capturedEntry?.cliSessionIds).toEqual({
      "claude-cli": "existing-claude-cli-session",
    });
    expect(capturedEntry?.claudeCliSessionId).toBe("existing-claude-cli-session");
  });

  it("honors explicit gateway session-id resumes for terminal main rows", async () => {
    const now = Date.parse("2026-05-18T09:48:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);

    const root = sessionDirs.make();
    const sessionsDir = `${root}/sessions`;
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = "terminal-main-session.jsonl";
    const transcriptPath = `${sessionsDir}/${sessionFile}`;
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
      "utf8",
    );
    await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
    const existingEntry = {
      sessionId: "terminal-main-session",
      sessionFile,
      status: "done",
      updatedAt: now - 10_000,
      sessionStartedAt: now - 60_000,
      lastInteractionAt: now - 10_000,
      startedAt: now - 20_000,
      endedAt: now - 15_000,
      runtimeMs: 5_000,
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: `${sessionsDir}/sessions.json`,
      entry: existingEntry,
      canonicalKey: "agent:main:main",
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": { ...existingEntry },
      };
      const result = await updater(store);
      capturedEntry = result as Record<string, unknown>;
      return result;
    });
    mockSuccessfulAgentCommand();

    await invokeAgent({
      message: "resume terminal main",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "terminal-main-session",
      idempotencyKey: "test-idem-terminal-main-explicit-resume",
    } as AgentParams);

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).toBe("terminal-main-session");
    expect(capturedEntry?.sessionId).toBe("terminal-main-session");
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
    expect(capturedEntry?.status).toBe("done");
    expect(capturedEntry?.startedAt).toBe(now - 20_000);
    expect(capturedEntry?.endedAt).toBe(now - 15_000);
    expect(capturedEntry?.runtimeMs).toBe(5_000);
  });

  it.each(["heartbeat", "cron"] as const)(
    "preserves terminal main session reuse for %s gateway runs",
    async (runKind) => {
      const now = Date.parse("2026-05-18T09:49:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      setDateOnlyFakeClockActive(true);
      vi.setSystemTime(now);

      const root = sessionDirs.make();
      const sessionsDir = `${root}/sessions`;
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionFile = `terminal-main-${runKind}.jsonl`;
      const transcriptPath = `${sessionsDir}/${sessionFile}`;
      await fs.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
        "utf8",
      );
      await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
      const existingEntry = {
        sessionId: "terminal-main-session",
        sessionFile,
        status: "done",
        updatedAt: now - 10_000,
        sessionStartedAt: now - 60_000,
        lastInteractionAt: now - 10_000,
        startedAt: now - 20_000,
        endedAt: now - 15_000,
        runtimeMs: 5_000,
      };
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: `${sessionsDir}/sessions.json`,
        entry: existingEntry,
        canonicalKey: "agent:main:main",
      });

      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          "agent:main:main": { ...existingEntry },
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mockSuccessfulAgentCommand();

      await invokeAgent({
        message: `${runKind} probe`,
        agentId: "main",
        sessionKey: "agent:main:main",
        bootstrapContextRunKind: runKind,
        idempotencyKey: `test-idem-terminal-main-${runKind}-reuse`,
      } as AgentParams);

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        bootstrapContextRunKind?: string;
      }>();
      expect(call.sessionId).toBe("terminal-main-session");
      expect(call.bootstrapContextRunKind).toBe("cron");
      expect(capturedEntry?.sessionId).toBe("terminal-main-session");
      expectSqliteSessionFileMarkerForEntry(capturedEntry);
    },
  );
});
