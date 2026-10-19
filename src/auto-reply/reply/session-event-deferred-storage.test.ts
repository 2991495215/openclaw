import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  enqueueAutomationSystemEvent,
  enqueueSystemEvent,
  prepareAutomationSystemEvents,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  prepareSessionEventTargetForHost,
} from "./session-event-target.js";
import {
  continuation,
  sessionKey,
  withTargetFixture,
} from "./session-event-target.test-support.js";

const dispatch = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unexpected reply dispatch for a retired event target");
  }),
);
// mock-isolation: Deferred storage selection must not dispatch a reply turn.
vi.mock("../dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatch,
}));

beforeEach(() => {
  continuation.mockClear();
  dispatch.mockClear();
  resetSystemEventsForTest();
  resetGatewayWorkAdmission();
});
afterAll(() => {
  continuation.mockRestore();
});

describe("deferred session event storage custody", () => {
  it("retires a reset generation's deferred notice without poisoning its automation", async () => {
    await withTargetFixture(async ({ env, storePath }) => {
      const retiredTarget = await captureSessionEventTargetForHost("main", sessionKey, { env });
      enqueueAutomationSystemEvent(
        "Old session notice",
        { sessionKey },
        {
          jobId: "scheduled-review",
          assertCurrent: () => assertSessionEventTargetCurrent(retiredTarget),
          prepare: () => prepareSessionEventTargetForHost(retiredTarget),
        },
      );
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey, env },
        {
          sessionId: "replacement-session",
          lifecycleRevision: "replacement-revision",
          updatedAt: 2,
        },
      );
      const currentTarget = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const currentOwner = {
        assertCurrent: () => assertSessionEventTargetCurrent(currentTarget),
        prepare: () => prepareSessionEventTargetForHost(currentTarget),
      };
      enqueueAutomationSystemEvent(
        "Current session notice",
        { sessionKey },
        {
          ...currentOwner,
          jobId: "scheduled-review",
        },
      );
      enqueueAutomationSystemEvent(
        "Other automation notice",
        { sessionKey },
        {
          ...currentOwner,
          jobId: "other-review",
        },
      );
      enqueueSystemEvent("Ordinary session notice", { sessionKey });

      const prepared = await prepareAutomationSystemEvents(sessionKey, "scheduled-review");
      try {
        expect(prepared.events.map((event) => event.text)).toEqual(["Current session notice"]);
        prepared.start();
        expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
          "Other automation notice",
          "Ordinary session notice",
        ]);
      } finally {
        prepared.release();
      }
      const nextRun = await prepareAutomationSystemEvents(sessionKey, "scheduled-review");
      try {
        expect(nextRun.events).toEqual([]);
        nextRun.start();
      } finally {
        nextRun.release();
      }
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
  it.each(["replaced", "temporarily-missing"] as const)(
    "retires only positively replaced deferred storage: %s",
    async (change) => {
      await withTargetFixture(async (state) => {
        const original = state.path("notice-original");
        const replacement = state.path("notice-replacement");
        const alias = state.path("notice-store");
        await fs.mkdir(original);
        await fs.mkdir(replacement);
        await fs.symlink(original, alias, "junction");
        const storePath = path.join(alias, "openclaw-agent.sqlite");
        for (const directory of [original, replacement]) {
          const database = openOpenClawAgentDatabase({
            agentId: "main",
            path: path.join(directory, "openclaw-agent.sqlite"),
            env: state.env,
          });
          writeSessionEntry(database, sessionKey, {
            sessionId: directory === original ? "original-notice" : "replacement-notice",
            lifecycleRevision: directory === original ? "original" : "replacement",
            updatedAt: 1,
          });
        }
        setRuntimeConfigSnapshot({
          agents: { entries: { main: {} } },
          session: { store: storePath },
        });
        const retiredTarget = await captureSessionEventTargetForHost("main", sessionKey, {
          env: state.env,
        });
        const enqueue = (target: typeof retiredTarget, jobId: string) =>
          enqueueAutomationSystemEvent(
            "Same notice",
            { sessionKey },
            {
              jobId,
              assertCurrent: () => assertSessionEventTargetCurrent(target),
              prepare: () => prepareSessionEventTargetForHost(target),
            },
          );
        enqueue(retiredTarget, "review");
        enqueue(retiredTarget, "other-review");
        enqueueSystemEvent("Ordinary notice", { sessionKey });
        const before = peekSystemEventEntries(sessionKey);
        await fs.unlink(alias);
        if (change === "temporarily-missing") {
          await expect(prepareAutomationSystemEvents(sessionKey, "review")).rejects.toThrow(
            "storage changed after capture",
          );
          expect(peekSystemEventEntries(sessionKey)).toEqual(before);
          await fs.symlink(original, alias, "junction");
        } else {
          await fs.symlink(replacement, alias, "junction");
          const currentTarget = await captureSessionEventTargetForHost("main", sessionKey, {
            env: state.env,
          });
          enqueue(currentTarget, "review");
        }
        const current = peekSystemEventEntries(sessionKey);
        const expectedId = change === "replaced" ? current.at(-1)?.id : before[0]?.id;
        const prepared = await prepareAutomationSystemEvents(sessionKey, "review");
        try {
          expect(prepared.events.map((event) => event.id)).toEqual([expectedId]);
          prepared.start();
        } finally {
          prepared.release();
        }
        expect(peekSystemEventEntries(sessionKey)).toEqual([before[1], before[2]]);
        const next = await prepareAutomationSystemEvents(sessionKey, "review");
        try {
          expect(next.events).toEqual([]);
          next.start();
        } finally {
          next.release();
        }
        expect(dispatch).not.toHaveBeenCalled();
      });
    },
  );
});
