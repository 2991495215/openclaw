import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { runMigrationApply } from "../commands/migrate/apply.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MigrationProviderPlugin } from "../plugins/migration-provider.types.js";
import { readAgentProvenance } from "../test-utils/agent-provenance.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createMigrationAgent } from "./migration-runtime.js";
import { summarizeMigrationItems } from "./migration.js";

it("creates an imported agent through offline migration, preserves existing state, and safely retries", async () => {
  const state = await createOpenClawTestState({ scenario: "minimal", label: "migration-agent" });
  onTestFinished(state.cleanup);
  await state.writeConfig({
    agents: { entries: { main: { name: "Original", workspace: state.workspaceDir } } },
    messages: { ackReaction: "🦞" },
  });
  const original = "Existing user instructions.\n";
  await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), original);
  const definition = {
    id: "imported-researcher",
    name: "Imported Researcher",
    workspace: state.path("imported-workspace"),
    agentDir: state.agentDir("imported-researcher"),
    model: "openai/gpt-5.5",
    identity: { name: "Researcher", avatar: "avatars/researcher.png" },
  };
  let result: Awaited<ReturnType<typeof createMigrationAgent>> | undefined;
  let staged = false;
  const provider: MigrationProviderPlugin = {
    id: "fixture",
    label: "Fixture",
    plan: () => ({
      providerId: "fixture",
      source: "synthetic",
      items: [],
      summary: summarizeMigrationItems([]),
    }),
    async apply(ctx, plan) {
      result = await createMigrationAgent(
        staged ? { ...ctx, stateDir: state.path("staging") } : ctx,
        definition,
      );
      return plan!;
    },
  };
  const apply = () =>
    runMigrationApply({
      provider,
      providerId: provider.id,
      opts: { noBackup: true, json: true },
      runtime: {
        log() {},
        error() {},
        exit(code) {
          throw new Error(`Unexpected migration exit ${code}`);
        },
      },
    });

  staged = true;
  await apply();
  expect(result).toMatchObject({ status: "error", reason: expect.stringContaining("promotion") });
  await expect(fs.stat(definition.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  staged = false;
  await apply();
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "created",
    agentId: definition.id,
  });
  const config = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
  expect(config.agents?.entries?.[definition.id]).toMatchObject({
    name: definition.name,
    workspace: definition.workspace,
    agentDir: definition.agentDir,
    model: definition.model,
    identity: definition.identity,
  });
  expect(config.agents?.entries?.main?.name).toBe("Original");
  expect(config.messages?.ackReaction).toBe("🦞");
  expect(await fs.readFile(path.join(state.workspaceDir, "AGENTS.md"), "utf8")).toBe(original);
  expect(readAgentProvenance(definition.id, { env: state.env })).toMatchObject({
    createdVia: "operator",
  });
  await expect(
    fs.stat(path.join(definition.agentDir, "openclaw-agent.sqlite")),
  ).resolves.toBeDefined();

  const configBytes = await fs.readFile(state.configPath, "utf8");
  await apply();
  expect(result).toMatchObject({ status: "existing", agentId: definition.id });
  expect(await fs.readFile(state.configPath, "utf8")).toBe(configBytes);

  definition.name = "Unrelated replacement";
  await apply();
  expect(result).toMatchObject({ status: "conflict" });
  expect(await fs.readFile(state.configPath, "utf8")).toBe(configBytes);
});
