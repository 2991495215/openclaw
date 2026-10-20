import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

export type StreamOutputChannel = "stdout" | "stderr";

// A drop severs the retained partial line, but only a "midline" drop leaves
// the next fragment's head inside an unknown line.
export type DroppedTail = false | "clean" | "midline";

export type BufferedOutput = {
  channel: StreamOutputChannel;
  chunk: string;
  truncatedTail: boolean;
  truncatedTailContinuesLine: boolean;
  precededByDrop: DroppedTail;
};

type LineState = {
  partialLines: Record<StreamOutputChannel, string>;
  discardUntilNewline: Record<StreamOutputChannel, boolean>;
};

type StreamLine = {
  line: string;
  truncated: boolean;
};

export function* readCronStreamChunk(
  state: LineState,
  entry: BufferedOutput,
  maxLineBytes: number,
): Generator<StreamLine> {
  const { channel } = entry;
  if (entry.precededByDrop) {
    // Never synthesize a line across a gap. A clean drop already ended its line.
    state.partialLines[channel] = "";
    state.discardUntilNewline[channel] = entry.precededByDrop === "midline";
  }
  let text = state.partialLines[channel] + entry.chunk;
  state.partialLines[channel] = "";
  for (;;) {
    const newline = text.indexOf("\n");
    if (newline < 0) {
      break;
    }
    const rawLine = text.slice(0, newline);
    text = text.slice(newline + 1);
    if (state.discardUntilNewline[channel]) {
      state.discardUntilNewline[channel] = false;
      continue;
    }
    const truncated = Buffer.byteLength(rawLine, "utf8") > maxLineBytes;
    const line = truncated ? truncateUtf8Prefix(rawLine, maxLineBytes) : rawLine;
    yield {
      line: line.endsWith("\r") ? line.slice(0, -1) : line,
      truncated,
    };
  }
  if (state.discardUntilNewline[channel]) {
    return;
  }
  // Finish this chunk before applying the next chunk's dropped-gap boundary.
  if (entry.truncatedTail || Buffer.byteLength(text, "utf8") > maxLineBytes) {
    const line = truncateUtf8Prefix(text, maxLineBytes);
    if (line) {
      yield { line: line.endsWith("\r") ? line.slice(0, -1) : line, truncated: true };
    }
    state.discardUntilNewline[channel] = entry.truncatedTail
      ? entry.truncatedTailContinuesLine
      : true;
    return;
  }
  state.partialLines[channel] = text;
}
