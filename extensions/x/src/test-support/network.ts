import { vi } from "vitest";

export type XFetch = (input: string, init?: RequestInit) => Promise<Response>;

const network = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { transport: new AsyncLocalStorage<XFetch>() };
});

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: async (hostname: string) => {
    if (hostname !== "api.x.com" && hostname !== "api.github.com") {
      throw new Error("Unexpected DNS lookup outside the synthetic X fixture");
    }
    return [{ address: "93.184.216.34", family: 4 }];
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-fetch")>()),
  fetchWithRuntimeDispatcher: (input: RequestInfo | URL, init?: RequestInit) => {
    const fetch = network.transport.getStore();
    if (!fetch) {
      throw new Error("X fixture request has no invocation-owned transport");
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return fetch(url, init);
  },
}));

// The real owner keeps OAuth and spend state; only its native network edge is scoped.
export function withXTestFetch<T extends object>(owner: T, fetch: XFetch): T {
  for (const key of Object.keys(owner)) {
    const operation: unknown = Reflect.get(owner, key);
    if (typeof operation === "function") {
      Reflect.set(owner, key, (...args: unknown[]) =>
        network.transport.run(fetch, () => Reflect.apply(operation, owner, args)),
      );
    }
  }
  return owner;
}
