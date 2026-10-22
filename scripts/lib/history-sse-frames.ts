import assert from "node:assert/strict";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

/** Raw history-benchmark framing; preserves bytes, including comments and line endings. */
export class HistorySseFrames {
  private parts: Buffer[] = [];
  private pending = 0;
  private lineBytes = 0;
  private previousEndingBytes = 0;
  private pendingCr = false;
  private pendingBoundary = false;
  private ended = false;
  scannedBytes = 0;
  joinedBytes = 0;
  frames = 0;

  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes = 32 * 1024 * 1024) {
    this.maxFrameBytes = maxFrameBytes;
  }

  get pendingBytes(): number {
    return this.pending;
  }

  private append(part: Buffer): void {
    if (part.length === 0) {
      return;
    }
    this.pending += part.length;
    if (this.pending > this.maxFrameBytes) {
      throw new Error("SSE frame budget exceeded");
    }
    this.parts.push(part);
  }

  private emit(delimiterBytes: number): { raw: Buffer; frame: string } {
    // A completed frame is materialized once; partial chunks are never joined or rescanned.
    const raw = Buffer.concat(this.parts, this.pending);
    this.joinedBytes += raw.length;
    this.frames++;
    this.parts = [];
    this.pending = 0;
    this.lineBytes = 0;
    this.previousEndingBytes = 0;
    return { raw, frame: raw.subarray(0, raw.length - delimiterBytes).toString("utf8") };
  }

  push(chunk: Buffer): Array<{ raw: Buffer; frame: string }> {
    if (this.ended) {
      throw new Error("SSE framer already ended");
    }
    const result: Array<{ raw: Buffer; frame: string }> = [];
    let start = 0;
    const emitAt = (end: number, delimiterBytes: number) => {
      this.append(chunk.subarray(start, end));
      result.push(this.emit(delimiterBytes));
      start = end;
    };
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      this.scannedBytes++;
      if (this.pendingCr) {
        this.pendingCr = false;
        if (byte === 10) {
          if (this.pendingBoundary) {
            emitAt(index + 1, this.previousEndingBytes + 2);
          } else {
            this.previousEndingBytes = 2;
          }
          this.pendingBoundary = false;
          continue;
        }
        if (this.pendingBoundary) {
          emitAt(index, this.previousEndingBytes + 1);
          this.pendingBoundary = false;
        } else {
          this.previousEndingBytes = 1;
        }
      }
      if (byte === 13) {
        // Defer CR until the next byte so split CRLF remains one line ending.
        this.pendingCr = true;
        this.pendingBoundary = this.lineBytes === 0;
        this.lineBytes = 0;
      } else if (byte === 10) {
        if (this.lineBytes === 0) {
          emitAt(index + 1, this.previousEndingBytes + 1);
        } else {
          this.lineBytes = 0;
          this.previousEndingBytes = 1;
        }
      } else {
        this.lineBytes++;
      }
    }
    this.append(chunk.subarray(start));
    return result;
  }

  finish(): Array<{ raw: Buffer; frame: string }> {
    if (this.ended) {
      throw new Error("SSE framer already ended");
    }
    this.ended = true;
    if (this.pendingCr && this.pendingBoundary) {
      this.pendingCr = false;
      this.pendingBoundary = false;
      return [this.emit(this.previousEndingBytes + 1)];
    }
    if (this.pending !== 0) {
      throw new Error("SSE stream ended with a truncated frame");
    }
    return [];
  }
}

/** Retained wire checks shared by the runtime consumer and offline replay. */
export function validateHistoryPage(body: unknown, sessionKey: string, count: number) {
  assert(isRecord(body));
  assert.equal(body.sessionKey, sessionKey);
  assert(Array.isArray(body.messages));
  assert(Array.isArray(body.items));
  assert.equal(body.messages.length, count);
  assert.equal(body.items.length, count);
  assert.equal(body.hasMore, false);
  for (let index = 0; index < count; index++) {
    const message: unknown = body.messages[index];
    assert(isRecord(message) && Array.isArray(message.content));
    assert(
      message.content.some(
        (block: unknown) =>
          isRecord(block) &&
          typeof block.text === "string" &&
          block.text.startsWith("i2-retention-0-" + index + ":"),
      ),
    );
  }
  assert.deepEqual(body.items, body.messages);
  const messageId = (value: unknown) =>
    isRecord(value) && isRecord(value["__openclaw"]) ? value["__openclaw"].id : undefined;
  return {
    messages: body.messages.length,
    items: body.items.length,
    firstId: messageId(body.messages[0]),
    lastId: messageId(body.messages.at(-1)),
    hasMore: body.hasMore,
  };
}
