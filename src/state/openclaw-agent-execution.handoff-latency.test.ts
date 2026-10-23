import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { SqliteWorkerRequest } from "../infra/sqlite-worker-contract.js";
import {
  createAgentCreationWitnessFixture,
  createAgentCreationWitnessSource,
} from "./openclaw-agent-execution.creation-fixture.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

const cases = Array.from({ length: 5 }, (_, sample) =>
  [0, 16 * 1024].map((paddingBytes) => ({ sample, paddingBytes })),
).flat();
const summarize = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    count: values.length,
    median: sorted[Math.ceil(values.length / 2) - 1],
    p95: sorted[Math.ceil(values.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
};

it.for(cases)(
  "measures native worker handoff sample=$sample paddingBytes=$paddingBytes",
  async ({ sample, paddingBytes }) => {
    const options = createAgentCreationWitnessFixture();
    const execution = captureOpenClawAgentDatabaseExecution({
      ...options,
      env: {
        ...options.env,
        SYNTHETIC_HANDOFF_PADDING: "x".repeat(paddingBytes),
      },
    });
    const source = createAgentCreationWitnessSource();
    const read = () =>
      execution.runExisting(source, (scope) =>
        scope.execute({
          type: "session.entry.read",
          input: { sessionKeys: ["agent:main:synthetic-handoff"] },
        }),
      );
    const sends: Array<{
      worker: Worker;
      actor: number;
      contextSent: boolean;
      paddingBytes: number;
      commandBytes: number;
      nativePostMs: number;
    }> = [];
    // oxlint-disable-next-line typescript/unbound-method -- call supplies the worker receiver.
    const originalPost = Worker.prototype.postMessage;
    let observing = false;
    using messages = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      message: SqliteWorkerRequest,
      transferList,
    ) {
      if (!observing || message.type !== "execute") {
        return originalPost.call(this, message, transferList);
      }
      const command: unknown = deserialize(message.input);
      if (
        !isRecord(command) ||
        command.type !== "session.entry.read" ||
        !isRecord(command.input) ||
        !Array.isArray(command.input.sessionKeys) ||
        command.input.sessionKeys.length !== 1 ||
        command.input.sessionKeys[0] !== "agent:main:synthetic-handoff"
      ) {
        return originalPost.call(this, message, transferList);
      }
      // Capture sizes before ownership transfer detaches the command buffer.
      const commandBytes = message.input.byteLength;
      const capturedPadding =
        message.stateContext?.initializationEnvironment?.SYNTHETIC_HANDOFF_PADDING;
      const started = performance.now();
      const result = originalPost.call(this, message, transferList);
      const nativePostMs = performance.now() - started;
      sends.push({
        worker: this,
        actor: message.actor,
        contextSent: message.stateContext !== undefined,
        paddingBytes: capturedPadding?.length ?? 0,
        commandBytes,
        nativePostMs,
      });
      return result;
    });
    try {
      const started = performance.now();
      await execution.prepare(source);
      const preparationMs = performance.now() - started;
      for (let warmup = 0; warmup < 2; warmup++) {
        expect(await read()).toMatchObject({ entries: [] });
      }
      const hostLoad = loadavg();
      const requestMs: number[] = [];
      observing = true;
      for (let index = 0; index < 16; index++) {
        const requestStarted = performance.now();
        const result = await read();
        requestMs.push(performance.now() - requestStarted);
        expect(result).toMatchObject({ entries: [] });
      }
      observing = false;
      expect(sends).toHaveLength(requestMs.length);
      expect(new Set(sends.map((send) => send.worker)).size).toBe(1);
      expect(new Set(sends.map((send) => send.actor)).size).toBe(1);
      expect(sends.every((send) => send.contextSent && send.paddingBytes === paddingBytes)).toBe(
        true,
      );
      console.log(
        JSON.stringify({
          diagnostic: "agent-worker-inherited-context",
          sample,
          paddingBytes,
          preparationMs,
          hostLoad,
          requests: requestMs.length,
          contextTransmissions: sends.filter((send) => send.contextSent).length,
          commandBytes: [...new Set(sends.map((send) => send.commandBytes))],
          nativePostMs: summarize(sends.map((send) => send.nativePostMs)),
          requestIncludesObserverDecode: true,
          requestMs: summarize(requestMs),
        }),
      );
    } finally {
      observing = false;
      await execution.release();
    }
  },
);
