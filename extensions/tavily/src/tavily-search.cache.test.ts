import { afterEach, describe, expect, it, vi } from "vitest";
import { createTavilyWebSearchProvider } from "./tavily-search-provider.js";
import { captureTavilyTools } from "./tavily-tools.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Tavily search cache TTL", () => {
  it.each(["tavily_search", "tavily_extract"] as const)(
    "%s partitions cached results by the resolved credential",
    async (toolName) => {
      const accounts = new Map([
        ["Bearer tavily-cache-key-A", "Account A"],
        ["Bearer tavily-cache-key-a", "Account B"],
      ]);
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const account = accounts.get(new Headers(init?.headers).get("Authorization") ?? "");
        if (!account) {
          throw new Error("Unexpected synthetic Tavily credential");
        }
        return Response.json({
          results: [
            {
              url: "https://example.com/credential-scoped-content",
              content: account,
              raw_content: account,
            },
          ],
        });
      });
      const configForKey = (apiKey: string) => ({
        tools: { web: { search: { cacheTtlMinutes: 15 } } },
        plugins: { entries: { tavily: { config: { webSearch: { apiKey } } } } },
      });
      let config = configForKey("tavily-cache-key-A");
      const tool = captureTavilyTools(config)(toolName, {
        config,
        getRuntimeConfig: () => config,
      });
      const args =
        toolName === "tavily_search"
          ? { query: "Tavily credential-scoped cache" }
          : { urls: ["https://example.com/credential-scoped-content"] };
      const contentField = toolName === "tavily_search" ? "snippet" : "rawContent";
      const run = async () => (await tool.execute("cache-credential", args)).details;

      const first = await run();
      expect(first).toMatchObject({
        results: [{ [contentField]: expect.stringContaining("Account A") }],
      });
      expect(first).not.toHaveProperty("cached");

      config = configForKey("tavily-cache-key-a");
      const second = await run();
      expect(second).toMatchObject({
        results: [{ [contentField]: expect.stringContaining("Account B") }],
      });
      expect(second).not.toHaveProperty("cached");

      config = configForKey("tavily-cache-key-A");
      expect(await run()).toMatchObject({
        cached: true,
        results: [{ [contentField]: expect.stringContaining("Account A") }],
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { kind: "web_search", cacheTtlMinutes: 1 },
    { kind: "tavily_search", cacheTtlMinutes: 0 },
  ])(
    "$kind applies the current $cacheTtlMinutes-minute TTL to cached results",
    async ({ kind, cacheTtlMinutes }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      let requests = 0;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        requests += 1;
        return Response.json({
          results: [
            {
              title: `Result ${requests}`,
              url: `https://example.com/${requests}`,
              content: `Body ${requests}`,
            },
          ],
        });
      });
      const search = async (ttl: number) => {
        const searchConfig = { cacheTtlMinutes: ttl };
        const config = {
          tools: { web: { search: searchConfig } },
          plugins: {
            entries: { tavily: { config: { webSearch: { apiKey: "tavily-test-key" } } } },
          },
        };
        const query = `Tavily ${kind} current TTL ${cacheTtlMinutes}`;
        if (kind === "tavily_search") {
          const tool = captureTavilyTools(config)("tavily_search");
          return (await tool.execute("cache-ttl", { query })).details as Record<string, unknown>;
        }
        const tool = createTavilyWebSearchProvider().createTool({ config, searchConfig });
        if (!tool) {
          throw new Error("Expected Tavily search tool");
        }
        return await tool.execute({ query });
      };

      const original = await search(15);
      expect(await search(15)).toEqual({ ...original, cached: true });
      expect(fetch).toHaveBeenCalledTimes(1);

      if (cacheTtlMinutes > 0) {
        clock.mockReturnValue(Date.now() + 60_000);
      }
      const fresh = await search(cacheTtlMinutes);
      expect(fresh.cached).toBeUndefined();
      expect(fresh.results).toEqual([expect.objectContaining({ url: "https://example.com/2" })]);
      expect(fetch).toHaveBeenCalledTimes(2);

      if (cacheTtlMinutes === 0) {
        const next = await search(0);
        expect(next.cached).toBeUndefined();
        expect(next.results).toEqual([expect.objectContaining({ url: "https://example.com/3" })]);
        expect(await search(15)).toEqual({ ...original, cached: true });
        expect(fetch).toHaveBeenCalledTimes(3);
      } else {
        expect(await search(1)).toEqual({ ...fresh, cached: true });
        expect(fetch).toHaveBeenCalledTimes(2);
      }
    },
  );
});
