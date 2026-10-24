import type { Model, StreamOptions } from "../types.js";

/** Required conversation identity is independent of optional prompt caching. */
export function resolveOpencodeSessionHeaders(
  model: Pick<Model, "baseUrl" | "headers">,
  options?: Pick<StreamOptions, "sessionId" | "headers">,
): Record<string, string> | undefined {
  if (!options?.sessionId) {
    return options?.headers;
  }
  const url = URL.parse(model.baseUrl);
  if (!(url?.protocol === "https:" && url.hostname.replace(/\.$/, "") === "opencode.ai")) {
    return options?.headers;
  }
  if (hasOpencodeSessionHeader(model, options)) {
    return options.headers;
  }
  return { ...options.headers, "x-opencode-session": options.sessionId };
}

export function hasOpencodeSessionHeader(
  model: Pick<Model, "headers">,
  options?: Pick<StreamOptions, "headers">,
): boolean {
  return [model.headers, options?.headers].some((headers) =>
    Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "x-opencode-session"),
  );
}
