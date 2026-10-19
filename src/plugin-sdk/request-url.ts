// Host classification does not need HTTP clients or dispatcher construction.
export { isLoopbackHost } from "../gateway/net.js";

/** Parse HTTP(S) syntax only; network and credential policy stays with the caller. */
export function parseHttpUrl(
  value: string,
  invalidUrlMessage: string,
  invalidProtocolMessage: string,
): URL {
  const parsed = URL.parse(value);
  if (!parsed) {
    throw new Error(invalidUrlMessage);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(invalidProtocolMessage);
  }
  return parsed;
}

/** Extract a string URL from the common request-like inputs accepted by fetch helpers. */
export function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  // Avoid `instanceof Request` so tests, fetch shims, and cross-realm Request
  // objects can still expose their URL through the structural `url` field.
  if (typeof input === "object" && input && "url" in input && typeof input.url === "string") {
    return input.url;
  }
  return "";
}
