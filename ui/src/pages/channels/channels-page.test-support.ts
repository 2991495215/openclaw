import { vi } from "vitest";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";

export const channelSnapshot = (
  overrides: Partial<ChannelsStatusSnapshot> = {},
): ChannelsStatusSnapshot => ({
  ts: 0,
  channelOrder: [],
  channelLabels: {},
  channels: {},
  channelAccounts: {},
  channelDefaultAccountId: {},
  ...overrides,
});

export function channelStatus(id: string, label: string, configured = false, description?: string) {
  return channelSnapshot({
    channelOrder: [id],
    channelLabels: { [id]: label },
    channels: { [id]: { configured } },
    ...(description ? { channelDetailLabels: { [id]: description } } : {}),
  });
}

export const plugin = (id: string, name: string, overrides: Partial<PluginCatalogItem> = {}) => ({
  id,
  name,
  installed: true,
  enabled: true,
  state: "enabled",
  hasIcon: true,
  ...overrides,
});

export function mockIcon(url: string) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockReturnValue(url);
  return fetchMock;
}

export function iconRequests(fetchMock: ReturnType<typeof mockIcon>) {
  return fetchMock.mock.calls
    .map(([input]) =>
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    )
    .filter((url) => url.includes("/__openclaw__/plugin-icon/"));
}
