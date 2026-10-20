import { createXApiClient as createNativeXApiClient } from "../api.js";
import { withXTestFetch, type XFetch } from "./network.js";

export * from "../api.js";
export type { XFetch } from "./network.js";

export function createXApiClient({
  fetch,
  ...options
}: Parameters<typeof createNativeXApiClient>[0] & { fetch?: XFetch }) {
  const api = createNativeXApiClient(options);
  return fetch ? withXTestFetch(api, fetch) : api;
}
