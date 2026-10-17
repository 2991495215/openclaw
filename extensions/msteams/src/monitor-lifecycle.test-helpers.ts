import { vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsPollStore } from "./polls.js";

export function createConfig(): OpenClawConfig {
  return {
    channels: {
      msteams: {
        enabled: true,
        appId: "app-id",
        appPassword: "app-password", // pragma: allowlist secret
        tenantId: "tenant-id",
        legacyWebhook: false,
        webhook: {
          path: "/api/messages",
        },
      },
    },
  } as OpenClawConfig;
}

export function updateMSTeamsConfig(
  cfg: OpenClawConfig,
  patch: NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>,
): void {
  const msteams = cfg.channels?.msteams;
  if (!cfg.channels || !msteams) {
    throw new Error("Expected Microsoft Teams config fixture");
  }
  cfg.channels.msteams = {
    ...msteams,
    ...patch,
  };
}

export function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

export function createStores() {
  return {
    conversationStore: {} as MSTeamsConversationStore,
    pollStore: {} as MSTeamsPollStore,
  };
}

export function createSdkContext<T extends object>(activity: T) {
  return {
    activity,
    reply: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    api: {
      teams: { getById: vi.fn(async (_teamId: string) => ({ aadGroupId: "fixture-group" })) },
      conversations: {
        activities: vi.fn(() => ({
          update: vi.fn(async () => ({})),
          delete: vi.fn(async () => {}),
        })),
      },
    },
    stream: {
      events: { on: vi.fn(() => 1), off: vi.fn() },
      emit: vi.fn(),
      update: vi.fn(),
      clearText: vi.fn(),
      close: vi.fn(async () => undefined),
      canceled: false,
    },
  };
}
