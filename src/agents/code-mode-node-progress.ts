import type { CodeModeOutputSource } from "./code-mode-json.js";

// One task owns this bounded prefix. The host reads it only after Worker termination.
// A termination during append can truncate the last in-flight diagnostic entry.
const HEADER_BYTES = 64;
export class CodeModeNodeProgress {
  readonly buffer: SharedArrayBuffer;
  private readonly state: Int32Array;
  private readonly headers: DataView;
  private readonly bytes: Buffer;

  constructor(buffer: SharedArrayBuffer | number) {
    this.buffer =
      typeof buffer === "number" ? new SharedArrayBuffer(HEADER_BYTES + buffer) : buffer;
    this.state = new Int32Array(this.buffer, 0, 2);
    this.headers = new DataView(this.buffer);
    this.bytes = Buffer.from(this.buffer, HEADER_BYTES);
  }

  get deadline(): number {
    return this.headers.getFloat64(56);
  }

  set deadline(value: number) {
    this.headers.setFloat64(56, value);
  }

  get networkContentObserved(): boolean {
    return Atomics.load(this.state, 1) === 1;
  }

  observeNetworkContent(): void {
    Atomics.store(this.state, 1, 1);
  }

  append(json: string): number {
    const [count, originalBytes, length] = this.header();
    const part = (count === 0 ? "[" : ",") + json;
    const total = originalBytes + Buffer.byteLength(part);
    const written = originalBytes === length ? this.bytes.write(part, length) : 0;
    this.headers.setFloat64(16, total);
    this.headers.setFloat64(24, length + written);
    this.headers.setFloat64(8, count + 1);
    return count + 1;
  }

  resetOutput(): void {
    for (let field = 0; field < 3; field++) {
      this.headers.setFloat64(8 + field * 8, 0);
    }
  }

  output(): CodeModeOutputSource {
    const [count, originalBytes, length] = this.header();
    const json = count === 0 ? "[]" : this.bytes.toString("utf8", 0, length);
    return {
      count,
      source:
        count === 0 || originalBytes + 1 <= this.bytes.length
          ? { kind: "complete", json: count === 0 ? json : json + "]" }
          : { kind: "prefix", json, originalBytes: originalBytes + 1 },
    };
  }

  private header() {
    return [
      this.headers.getFloat64(8),
      this.headers.getFloat64(16),
      this.headers.getFloat64(24),
    ] as const;
  }
}
