import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  sampleHistoryNativeTree,
  type HistoryNativeLifetime,
} from "../../scripts/lib/history-native-samples.ts";
import { HistorySseFrames, validateHistoryPage } from "../../scripts/lib/history-sse-frames.ts";

function decode(raw: Buffer, cuts: number[]) {
  const parser = new HistorySseFrames();
  const frames = [];
  let start = 0;
  for (const end of [...cuts, raw.length]) {
    frames.push(...parser.push(raw.subarray(start, end)));
    start = end;
  }
  frames.push(...parser.finish());
  return { parser, frames };
}

function allPartitions(length: number) {
  return Array.from({ length: 2 ** (length - 1) }, (_partition, mask) =>
    Array.from({ length: length - 1 }, (_byte, index) => index + 1).filter(
      (_cut, index) => mask & (1 << index),
    ),
  );
}

describe("history proof raw SSE consumer", () => {
  it("preserves exact LF, CRLF, CR and UTF-8 bytes over every small partition", () => {
    for (const text of ["x\n\n", "x\r\n\r\n", "x\r\r", "🙂\n\n", "é\r\n\r\n"]) {
      const raw = Buffer.from(text);
      for (const cuts of allPartitions(raw.length)) {
        const { parser, frames } = decode(raw, cuts);
        expect(frames.map((f) => f.frame)).toEqual([
          text.startsWith("x") ? "x" : text.startsWith("🙂") ? "🙂" : "é",
        ]);
        expect(Buffer.concat(frames.map((f) => f.raw))).toEqual(raw);
        expect(parser.pendingBytes).toBe(0);
        expect(parser.scannedBytes).toBe(raw.length);
        expect(parser.joinedBytes).toBe(raw.length);
      }
    }
  });

  it("keeps retry, heartbeat, multiple event order and trailing partial bytes", () => {
    const pieces = [
      "retry: 1000\r\n\r\n",
      ": keepalive\n\n",
      'event: history\ndata: {"text":"🙂é"}\n\n',
      "event: message\r\ndata: {}\r\n\r\n",
    ];
    const raw = Buffer.from(pieces.join(""));
    for (let width = 1; width <= 9; width++) {
      const cuts = Array.from(
        { length: Math.floor((raw.length - 1) / width) },
        (_, i) => (i + 1) * width,
      );
      const { frames } = decode(raw, cuts);
      expect(frames.map((f) => f.raw.toString())).toEqual(pieces);
    }
    const parser = new HistorySseFrames();
    expect(parser.push(Buffer.from("data: complete\n\ndata: tail"))).toHaveLength(1);
    expect(parser.pendingBytes).toBe(10);
    expect(() => parser.finish()).toThrow("truncated frame");
    expect(() => parser.push(Buffer.from("\n\n"))).toThrow("already ended");
    expect(() => new HistorySseFrames(3).push(Buffer.from("data"))).toThrow("budget exceeded");
    const invalid = decode(Buffer.from([100, 97, 116, 97, 58, 32, 255, 10, 10]), [7]);
    expect(invalid.frames[0]?.frame).toBe("data: �");
  });

  it("retains row, alias and order validation and malformed JSON errors", () => {
    const message = { content: [{ text: "i2-retention-0-0:🙂" }], __openclaw: { id: "row-0" } };
    const body = { sessionKey: "fixture", messages: [message], items: [message], hasMore: false };
    const raw = Buffer.from("event: history\r\ndata: " + JSON.stringify(body) + "\r\n\r\n");
    const frame = decode(
      raw,
      Array.from({ length: raw.length - 1 }, (_, i) => i + 1),
    ).frames[0];
    assert(frame);
    const parsed: unknown = JSON.parse(frame.frame.slice(frame.frame.indexOf("data: ") + 6));
    expect(validateHistoryPage(parsed, "fixture", 1)).toEqual({
      messages: 1,
      items: 1,
      firstId: "row-0",
      lastId: "row-0",
      hasMore: false,
    });
    expect(() => validateHistoryPage({ ...body, items: [] }, "fixture", 1)).toThrow();
    expect(() =>
      validateHistoryPage(
        { ...body, messages: [{ content: [{ text: "wrong order" }] }] },
        "fixture",
        1,
      ),
    ).toThrow();
    expect(() =>
      JSON.parse(decode(Buffer.from("data: {broken}\n\n"), [5]).frames[0]!.frame.slice(6)),
    ).toThrow();
  });

  it("counts one scan and one materialization per wire byte, not accumulated prefixes", () => {
    const raw = Buffer.from("event: history\ndata: " + "x".repeat(16_384) + "\n\n");
    const cuts = Array.from({ length: Math.floor(raw.length / 64) }, (_, i) => (i + 1) * 64);
    const { parser } = decode(raw, cuts);
    const oldCumulativeSearchChars = [...cuts, raw.length].reduce((sum, end) => sum + end, 0);
    expect(parser.scannedBytes).toBe(raw.length);
    expect(parser.joinedBytes).toBe(raw.length);
    expect(oldCumulativeSearchChars).toBeGreaterThan(parser.scannedBytes * 100);
  });

  it.runIf(process.platform === "linux")(
    "keeps PID polling light and admits mapping reads only explicitly",
    () => {
      const lifetimes = new Map<number, HistoryNativeLifetime>();
      const light = sampleHistoryNativeTree(process.pid, lifetimes);
      expect(light.some((p) => p.pid === process.pid)).toBe(true);
      expect(light.every((p) => Object.keys(p.memory).length === 0)).toBe(true);
      expect(lifetimes.get(process.pid)?.startTicks).toMatch(/^\d+$/);
      const stage = sampleHistoryNativeTree(process.pid, lifetimes, true);
      expect(stage.find((p) => p.pid === process.pid)?.memory.Rss).toBeGreaterThan(0);
    },
  );
});

// Explicit retained-artifact replay is local proof, not a CI dependency on private paths.
if (process.env.HISTORY_SSE_REPLAY_INDEX) {
  it("replays every retained raw frame without identity normalization", () => {
    const index: Array<{ file: string; sha256: string }> = JSON.parse(
      readFileSync(process.env.HISTORY_SSE_REPLAY_INDEX!, "utf8"),
    );
    for (const entry of index) {
      const raw = readFileSync(entry.file);
      expect(createHash("sha256").update(raw).digest("hex")).toBe(entry.sha256);
      for (const width of [65_536, raw.length - 1]) {
        const cuts = Array.from(
          { length: Math.floor((raw.length - 1) / width) },
          (_, i) => (i + 1) * width,
        );
        const { parser, frames } = decode(raw, cuts);
        expect(frames).toHaveLength(1);
        const frame = frames[0]!;
        // Buffer.equals compares every byte natively; generic object equality walks millions of indices.
        expect(frame.raw.equals(raw), entry.file).toBe(true);
        expect(frame.frame).toBe(raw.subarray(0, -2).toString());
        const body: unknown = JSON.parse(frame.frame.slice(frame.frame.indexOf("data: ") + 6));
        expect(validateHistoryPage(body, "agent:main:team-shape-session-0", 16_384)).toMatchObject({
          messages: 16_384,
          items: 16_384,
          firstId: "team-shape-message-0-0",
          lastId: "team-shape-message-0-16383",
          hasMore: false,
        });
        expect(parser.scannedBytes).toBe(raw.length);
        expect(parser.joinedBytes).toBe(raw.length);
      }
    }
  });
}
