import { z } from "zod";

const text = z.string();

export const CaptureEventSchema = z
  .object({
    sessionId: text.min(1),
    ts: z.number().finite(),
    sourceScope: z.literal("openclaw"),
    sourceProcess: text,
    protocol: z.enum(["http", "https", "sse", "ws", "wss", "connect"]),
    direction: z.enum(["outbound", "inbound", "local"]),
    kind: z.enum([
      "connect",
      "tls-handshake",
      "request",
      "response",
      "ws-open",
      "ws-frame",
      "ws-close",
      "error",
      "retry-link",
    ]),
    flowId: text,
    method: text.optional(),
    host: text.optional(),
    path: text.optional(),
    status: z.number().optional(),
    closeCode: z.number().optional(),
    contentType: text.optional(),
    headersJson: text.optional(),
    dataText: text.optional(),
    dataBlobId: text.optional(),
    dataSha256: text.optional(),
    errorText: text.optional(),
    metaJson: text.optional(),
  })
  .strict();

export const CaptureQueryPresetSchema = z.enum([
  "double-sends",
  "retry-storms",
  "cache-busting",
  "ws-duplicate-frames",
  "missing-ack",
  "error-bursts",
]);
