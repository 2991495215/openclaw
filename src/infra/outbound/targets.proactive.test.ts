import { afterEach, beforeEach, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveProactiveDeliveryTargetWithSessionRoute } from "./targets.js";

const cfg: OpenClawConfig = {
  channels: {
    telegram: {
      accounts: {
        work: { botToken: "work-test-token", allowFrom: ["*"] },
        personal: { botToken: "personal-test-token", allowFrom: ["*"] },
      },
    },
  },
};
const snapshot = captureActivePluginRegistrySnapshot();
const groupTopic = "telegram:-1003774691294:topic:47";
const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});
afterEach(() => restoreActivePluginRegistrySnapshot(snapshot));
function register(plugin = telegramPlugin) {
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
}
beforeEach(() => register());
type Route = Awaited<ReturnType<typeof resolveProactiveDeliveryTargetWithSessionRoute>>;
function expectRoute(result: Route, expected: Pick<Route, "to" | "threadId" | "chatType">) {
  expect(result).toMatchObject({ channel: "telegram", accountId: "work", ...expected });
}

it.each(["target throws", "target rejects"] as const)(
  "ordinary proactive delivery retains configured delivery when %s",
  async (failure) => {
    const messaging: NonNullable<ChannelPlugin["messaging"]> = { ...telegramPlugin.messaging };
    const plugin: ChannelPlugin = { ...telegramPlugin, messaging };
    if (failure === "target throws") {
      messaging.targetResolver = {
        looksLikeId: () => {
          throw new Error("target failed");
        },
      };
    } else {
      messaging.targetResolver = { looksLikeId: () => false };
      plugin.directory = {
        listGroups: async () => [
          { kind: "group", id: "-1003774691294:topic:47", name: "first" },
          { kind: "group", id: "-1003774691294:topic:47", name: "second" },
        ],
      };
    }
    register(plugin);
    const result = await resolveProactiveDeliveryTargetWithSessionRoute({
      cfg,
      agentId: "main",
      policy: { target: "telegram", to: groupTopic, accountId: "work" },
    });
    expectRoute(result, { to: groupTopic });
  },
);
