import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerPluginSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createOpenShellSandboxBackendFactory,
  createOpenShellSandboxBackendManager,
} from "./src/backend.js";
import { createOpenShellPluginConfigSchema, resolveOpenShellPluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "openshell",
  name: "OpenShell Sandbox",
  description: "OpenShell-backed sandbox runtime for agent exec and file tools.",
  configSchema: createOpenShellPluginConfigSchema(),
  register(api) {
    api.registerCli(
      async ({ program, config }) => {
        const { registerOpenShellWorkerCli } = await import("./src/worker-cli.js");
        registerOpenShellWorkerCli(program, config);
      },
      {
        descriptors: [
          {
            name: "openshell",
            description: "Manage OpenShell brokered workers",
            hasSubcommands: true,
          },
        ],
      },
    );
    if (api.registrationMode !== "full") {
      return;
    }
    const pluginConfig = resolveOpenShellPluginConfig(api.pluginConfig);
    const workspace = pluginConfig.worker?.agentWorkspace;
    if (workspace) {
      api.on("before_prompt_build", (_event, context) => {
        if (context.agentId !== workspace.agentId) {
          return undefined;
        }
        // File Transfer owns the binding, including after its service reloads.
        const config = api.runtime.config.current();
        const workspaces = asOptionalRecord(
          config.plugins?.entries?.["file-transfer"]?.config?.workspaces,
        );
        const binding = asOptionalRecord(workspaces?.[workspace.agentId]);
        if (typeof binding?.nodeId !== "string" || binding.remoteRoot !== workspace.remoteRoot) {
          return undefined;
        }
        return {
          appendSystemContext:
            "This agent's canonical workspace documents are on paired node " +
            JSON.stringify(binding.nodeId) +
            " under " +
            JSON.stringify(binding.remoteRoot) +
            ". Use file_fetch and file_write with that node and an absolute document path, subject to the existing file policy. Ordinary read/write/edit/exec tools address this session's task workspace, not those shared agent documents. Do not create a local shadow or fall back to Gateway files when the node is unavailable.",
        };
      });
    }
    registerPluginSandboxBackend(api, "openshell", {
      factory: createOpenShellSandboxBackendFactory({
        pluginConfig,
      }),
      manager: createOpenShellSandboxBackendManager({
        pluginConfig,
      }),
      resolveWorkdir: () => pluginConfig.remoteWorkspaceDir,
    });
  },
});
