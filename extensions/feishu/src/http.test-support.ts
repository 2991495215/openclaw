import type { IncomingMessage, ServerResponse } from "node:http";
import { vi } from "vitest";

type DispatcherInit = RequestInit & { dispatcher?: unknown };

export async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
  }
  return body;
}

export function stripDispatcher(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || !("dispatcher" in init)) {
    return init;
  }
  const { dispatcher: _dispatcher, ...rest } = init as DispatcherInit;
  return rest;
}

/** Observe the consumer without replacing the native response, reader, or chunks. */
export function observeResponseBody(response: Response): {
  bytesRead: number;
  cancelCalls: number;
} {
  const state = { bytesRead: 0, cancelCalls: 0 };
  const body = response.body;
  if (!body) {
    throw new Error("expected a response body to observe");
  }
  const getReader = body.getReader.bind(body);
  vi.spyOn(body, "getReader").mockImplementation(() => {
    const reader = getReader();
    const read = reader.read.bind(reader);
    const cancel = reader.cancel.bind(reader);
    vi.spyOn(reader, "read").mockImplementation(async () => {
      const next = await read();
      if (!next.done) {
        state.bytesRead += next.value.byteLength;
      }
      return next;
    });
    vi.spyOn(reader, "cancel").mockImplementation((reason) => {
      const result = cancel(reason);
      state.cancelCalls += 1;
      return result;
    });
    return reader;
  });
  return state;
}

export function writeOversizedJson(
  res: ServerResponse,
  totalBytes: number,
  jsonPrefix: string,
): void {
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  let bytesWritten = 0;
  res.writeHead(200, { "content-type": "application/json" });
  const prefix = Buffer.from(jsonPrefix);
  bytesWritten += prefix.byteLength;
  res.write(prefix);
  const sendChunk = () => {
    if (res.destroyed) {
      return;
    }
    if (bytesWritten >= totalBytes) {
      res.end('"}');
      return;
    }
    const remaining = totalBytes - bytesWritten;
    const size = Math.min(chunk.byteLength, remaining);
    bytesWritten += size;
    const ok = res.write(chunk.subarray(0, size));
    if (ok) {
      setImmediate(sendChunk);
      return;
    }
    res.once("drain", sendChunk);
  };
  setImmediate(sendChunk);
}
