import { AgentSessionCompaction } from "./agent-session-compaction.js";
import { ExtensionRunner, type ToolDefinition, wrapRegisteredTools } from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import type { SlashCommandInfo } from "./slash-commands.js";
import { createSyntheticSourceInfo } from "./source-info.js";

function describeCommands<T extends Pick<SlashCommandInfo, "description" | "sourceInfo">>(
  commands: readonly T[],
  source: SlashCommandInfo["source"],
  name: (command: T) => string,
): SlashCommandInfo[] {
  return commands.map((command) => ({
    name: name(command),
    description: command.description,
    source,
    sourceInfo: command.sourceInfo,
  }));
}

export abstract class AgentSessionExtensions extends AgentSessionCompaction {
  private refreshCurrentModelFromRegistry(): void {
    const currentModel = this.model;
    if (!currentModel) {
      return;
    }

    const refreshedModel = this.sessionModelRegistry.find(currentModel.provider, currentModel.id);
    if (!refreshedModel || refreshedModel === currentModel) {
      return;
    }

    this.agent.state.model = refreshedModel;
  }

  private bindExtensionCore(runner: ExtensionRunner): void {
    const reportSendError = (event: string, err: unknown) => {
      runner.emitError({
        extensionPath: "<runtime>",
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    };
    const getCommands = (): SlashCommandInfo[] => [
      ...describeCommands(
        runner.getRegisteredCommands(),
        "extension",
        (command) => command.invocationName,
      ),
      ...describeCommands(this.promptTemplates, "prompt", (template) => template.name),
      ...describeCommands(
        this.sessionResourceLoader.getSkills().skills,
        "skill",
        (skill) => `skill:${skill.name}`,
      ),
    ];

    runner.bindCoreAsync(
      {
        sendMessage: (message, options) => {
          this.sendCustomMessage(message, options).catch((err: unknown) =>
            reportSendError("send_message", err),
          );
        },
        sendUserMessage: (content, options) => {
          this.sendUserMessage(content, options).catch((err: unknown) =>
            reportSendError("send_user_message", err),
          );
        },
        // Retained third-party synchronous persistence adapters.
        appendEntry: (customType, data) => {
          this.sessionManager.appendCustomEntry(customType, data);
        },
        appendEntryAsync: (customType, data) =>
          this.sessionManager.appendCustomEntryAsync(customType, data),
        setSessionName: (name) => {
          this.setSessionName(name);
        },
        setSessionNameAsync: (name) => this.setSessionNameAsync(name),
        getSessionName: () => {
          return this.sessionManager.getSessionName();
        },
        setLabel: (entryId, label) => {
          this.sessionManager.appendLabelChange(entryId, label);
        },
        setLabelAsync: async (entryId, label) => {
          await this.sessionManager.appendLabelChangeAsync(entryId, label);
        },
        getActiveTools: () => this.getActiveToolNames(),
        getAllTools: () => this.getAllTools(),
        setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
        refreshTools: () => this.refreshToolRegistry(),
        getCommands,
        setModel: async (model) => {
          if (!this.sessionModelRegistry.hasConfiguredAuth(model)) {
            return false;
          }
          await this.setModel(model);
          return true;
        },
        getThinkingLevel: () => this.thinkingLevel,
        setThinkingLevel: (level) => this.setThinkingLevel(level),
      },
      {
        getModel: () => this.model,
        isIdle: () => !this.isStreaming,
        getSignal: () => this.agent.signal,
        abort: () => {
          void this.abort();
        },
        hasPendingMessages: () => this.pendingMessageCount > 0,
        shutdown: () => {},
        getContextUsage: () => this.getContextUsage(),
        compact: (options) => {
          void (async () => {
            try {
              const result = await this.compact(options?.customInstructions);
              options?.onComplete?.(result);
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              options?.onError?.(err);
            }
          })();
        },
        getSystemPrompt: () => this.systemPrompt,
      },
      {
        registerProvider: (name, config) => {
          this.sessionModelRegistry.registerProvider(name, config);
          this.refreshCurrentModelFromRegistry();
        },
        unregisterProvider: (name) => {
          this.sessionModelRegistry.unregisterProvider(name);
          this.refreshCurrentModelFromRegistry();
        },
      },
    );
  }

  /** Replace a runtime-owned tool surface without restarting its active agent loop. */
  replaceCustomTools(customTools: ToolDefinition[], activeToolNames: string[]): void {
    this.customTools = customTools;
    this.allowedToolNames = new Set(activeToolNames);
    this.refreshToolRegistry(activeToolNames);
  }

  private refreshToolRegistry(activeToolNames = this.getActiveToolNames()): void {
    const allCustomTools = [
      ...this.currentExtensionRunner.getAllRegisteredTools(),
      ...this.customTools.map((definition) => ({
        definition,
        sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
      })),
    ].filter((tool) => this.allowedToolNames.has(tool.definition.name));
    this.toolDefinitions = new Map(allCustomTools.map((tool) => [tool.definition.name, tool]));
    this.toolRegistry = new Map(
      wrapRegisteredTools(allCustomTools, this.currentExtensionRunner).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    this.setActiveToolsByName([...new Set([...activeToolNames, ...this.toolRegistry.keys()])]);
  }

  protected buildRuntime(options: {
    activeToolNames?: string[];
    flagValues?: Map<string, boolean | string>;
  }): void {
    const extensionsResult = this.sessionResourceLoader.getExtensions();
    if (options.flagValues) {
      for (const [name, value] of options.flagValues) {
        extensionsResult.runtime.flagValues.set(name, value);
      }
    }

    this.currentExtensionRunner = new ExtensionRunner(
      extensionsResult.extensions,
      extensionsResult.runtime,
      this.cwd,
      this.sessionManager,
      this.sessionModelRegistry,
    );
    if (this.extensionRunnerRef) {
      this.extensionRunnerRef.current = this.currentExtensionRunner;
    }
    this.bindExtensionCore(this.currentExtensionRunner);

    this.refreshToolRegistry(options.activeToolNames);
  }

  async reload(): Promise<void> {
    const previousFlagValues = this.currentExtensionRunner.getFlagValues();
    await emitSessionShutdownEvent(this.currentExtensionRunner, {
      type: "session_shutdown",
      reason: "reload",
    });
    await this.settingsManager.reload();
    this.agent.steeringMode = this.settingsManager.getSteeringMode();
    this.agent.followUpMode = this.settingsManager.getFollowUpMode();
    await this.sessionResourceLoader.reload();
    await this.sessionModelRegistry.refreshAsync();
    this.buildRuntime({
      activeToolNames: this.getActiveToolNames(),
      flagValues: previousFlagValues,
    });
  }
}
