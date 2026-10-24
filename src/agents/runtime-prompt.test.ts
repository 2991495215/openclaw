import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveSessionGitCoauthorPrompt } from "./git-coauthor-prompt.js";
import { resolveAgentRuntimePrompt } from "./runtime-prompt.js";

const {
  resolveChannelCapabilitiesMock,
  getMachineDisplayNameMock,
  resolveChannelMessageToolHintsMock,
  resolveChannelReactionGuidanceMock,
} = vi.hoisted(() => ({
  resolveChannelCapabilitiesMock: vi.fn(() => ["voice"]),
  getMachineDisplayNameMock: vi.fn(async () => "test-host"),
  resolveChannelMessageToolHintsMock: vi.fn(() => ["Use the message tool."]),
  resolveChannelReactionGuidanceMock: vi.fn(() => ({
    level: "minimal" as const,
    channelLabel: "Telegram",
  })),
}));

vi.mock("./channel-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-tools.js")>()),
  resolveChannelMessageToolHints: resolveChannelMessageToolHintsMock,
}));

vi.mock("./model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-default" })),
}));

vi.mock("../config/channel-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/channel-capabilities.js")>()),
  resolveChannelCapabilities: resolveChannelCapabilitiesMock,
}));

vi.mock("./shell-utils.js", () => ({
  detectRuntimeShell: vi.fn(() => "zsh"),
}));

vi.mock("./git-coauthor-prompt.js", () => ({
  resolveSessionGitCoauthorPrompt: vi.fn(),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: getMachineDisplayNameMock,
}));

vi.mock("../infra/os-summary.js", () => ({
  resolveRuntimeOsLabel: vi.fn(() => "TestOS 1.0"),
}));

describe("resolveAgentRuntimePrompt", () => {
  let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
  const gitCoauthorPrompt =
    "Git co-authors: add these exact trailers to every commit you make from this session.\n" +
    "Co-authored-by: ada <20+ada@users.noreply.github.com>";

  beforeEach(() => {
    vi.clearAllMocks();
    registrySnapshot = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            agentPrompt: { reactionGuidance: resolveChannelReactionGuidanceMock },
          },
        },
      ]),
    );
    vi.mocked(resolveSessionGitCoauthorPrompt).mockResolvedValue(gitCoauthorPrompt);
  });

  afterEach(() => restoreActivePluginRegistrySnapshot(registrySnapshot));

  it("resolves shared runtime and channel prompt facts", async () => {
    const config = {};
    const result = await resolveAgentRuntimePrompt({
      config,
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      cwd: "/tmp/workspace",
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-1",
      model: "openai/gpt-test",
      channel: "Telegram",
      accountId: "work",
      chatType: "group",
    });

    const channelContext = { cfg: config, channel: "telegram", accountId: "work" };
    expect(resolveChannelCapabilitiesMock).toHaveBeenCalledWith(channelContext);
    expect(resolveChannelReactionGuidanceMock).toHaveBeenCalledWith({
      cfg: config,
      accountId: "work",
    });
    expect(resolveChannelMessageToolHintsMock).toHaveBeenCalledWith(channelContext);
    expect(resolveSessionGitCoauthorPrompt).toHaveBeenCalledExactlyOnceWith({
      config,
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-1",
    });
    expect(result.runtimeInfo).toMatchObject({
      agentId: "main",
      host: "test-host",
      os: "TestOS 1.0",
      model: "openai/gpt-test",
      defaultModel: "openai/gpt-default",
      shell: "zsh",
      channel: "telegram",
      chatType: "group",
      capabilities: ["voice"],
      gitCoauthorPrompt,
    });
    expect(result).toEqual(
      expect.objectContaining({
        runtimeChannel: "telegram",
        runtimeCapabilities: ["voice"],
        reactionGuidance: { level: "minimal", channel: "Telegram" },
        messageToolHints: ["Use the message tool."],
      }),
    );
  });

  it.each([
    { name: "prepared credit", preparedGitCoauthorPrompt: gitCoauthorPrompt },
    { name: "explicit undefined", preparedGitCoauthorPrompt: undefined },
    { name: "explicit null", preparedGitCoauthorPrompt: null },
  ])("retains $name without refreshing session credit", async ({ preparedGitCoauthorPrompt }) => {
    const result = await resolveAgentRuntimePrompt({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:main",
      model: "openai/gpt-test",
      preparedGitCoauthorPrompt,
    });

    expect(result.runtimeInfo.gitCoauthorPrompt).toBe(preparedGitCoauthorPrompt ?? undefined);
    expect(resolveSessionGitCoauthorPrompt).not.toHaveBeenCalled();
  });
});
