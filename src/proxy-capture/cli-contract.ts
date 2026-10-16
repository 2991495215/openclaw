import { z } from "zod";
import { CaptureEventSchema, CaptureQueryPresetSchema } from "./capture-schema.js";
import type { AsyncDebugProxyCaptureStore } from "./store.types.js";

const text = z.string();

export const debugProxyCaptureWriteCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("capture.upsertSession"),
      input: z
        .object({
          id: text.min(1),
          startedAt: z.number().finite(),
          endedAt: z.number().finite().optional(),
          mode: text,
          sourceScope: z.literal("openclaw"),
          sourceProcess: text,
          proxyUrl: text.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("capture.endSession"),
      input: z.object({ sessionId: text.min(1), endedAt: z.number().finite() }).strict(),
    })
    .strict(),
  z.object({ type: z.literal("capture.recordEvent"), input: CaptureEventSchema }).strict(),
  z
    .object({
      type: z.literal("capture.recordEventWithPayload"),
      input: z
        .object({
          event: CaptureEventSchema,
          payload: z
            .object({
              data: text.nullable().optional(),
              base64: z.boolean().optional(),
              contentType: text.optional(),
              previewLimit: z.number().int().nonnegative().optional(),
            })
            .strict()
            .transform(({ data, base64, ...rest }) => ({
              ...rest,
              data: base64 && data != null ? Buffer.from(data, "base64") : data,
            })),
        })
        .strict(),
    })
    .strict(),
]);

export const debugProxyCliCommandSchema = z.discriminatedUnion("type", [
  ...debugProxyCaptureWriteCommandSchema.options,
  z
    .object({
      type: z.literal("capture.listSessions"),
      input: z.object({ limit: z.number().int().positive().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("capture.readBlob"),
      input: z.object({ blobId: text.min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("capture.queryPreset"),
      input: z
        .object({
          preset: CaptureQueryPresetSchema,
          sessionId: text.optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal("capture.purgeAll"), input: z.undefined().optional() }).strict(),
]);

export type DebugProxyCliStore = Pick<
  AsyncDebugProxyCaptureStore,
  | "dbPath"
  | "upsertSession"
  | "endSession"
  | "recordEvent"
  | "recordEventWithPayload"
  | "listSessions"
  | "readBlob"
  | "queryPreset"
  | "purgeAll"
>;

export function encodeDebugProxyPayload(
  payload: import("./store.worker-contract.js").CapturePayloadInput,
) {
  return {
    ...payload,
    ...(Buffer.isBuffer(payload.data)
      ? { data: payload.data.toString("base64"), base64: true }
      : {}),
  };
}
