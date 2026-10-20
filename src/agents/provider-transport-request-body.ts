import { encodedModelRequestBodyStream } from "@openclaw/ai/internal/model-request-body";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";

export function requestBodyHasStreamTrue(
  request: Request | undefined,
  init: RequestInit | undefined,
): boolean {
  const method = request?.method ?? init?.method;
  if (method && method.toUpperCase() !== "POST") {
    return false;
  }
  const headers = request?.headers ?? new Headers(init?.headers);
  const contentType = headers.get("content-type") ?? "";
  if (contentType && !/\bapplication\/json\b/i.test(contentType)) {
    return false;
  }

  const preparedStream = encodedModelRequestBodyStream(init?.body);
  if (preparedStream !== undefined) {
    return preparedStream;
  }
  if (typeof init?.body !== "string" || !init.body) {
    return false;
  }
  return safeParseJsonRecord(init.body)?.stream === true;
}
