import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { closeSkillsWatchers } from "../runtime/refresh.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";
import {
  resolveWorkspaceSkillSourcePlan,
  splitSkillSourcePlan,
} from "./workspace-skill-sources.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeSkillsWatchers(true);
});

async function writeSkill(root: string, name: string, description: string) {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow the ${description} procedure.\n`,
  );
}

describe("Workshop discovery contract", () => {
  it("P1: resolves every precedence tier through the loader and prompt snapshot", async () => {
    const home = tempDirs.make("workshop-precedence-");
    await withEnvAsync(
      { HOME: home, OPENCLAW_HOME: undefined, OPENCLAW_STATE_DIR: undefined },
      async () => {
        const workspace = path.join(home, "workspace");
        const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
        const roots = [
          path.join(home, "extra"),
          path.join(home, "bundled"),
          path.join(agentDir, "workshop-skills"),
          path.join(home, ".openclaw", "skills"),
          path.join(home, ".agents", "skills"),
          path.join(workspace, "skills"),
        ];
        const config = {
          plugins: { enabled: false },
          agents: { entries: { main: { agentDir } } },
          skills: { load: { watch: false, extraDirs: [roots[0]] } },
        };
        for (let winner = 0; winner < roots.length; winner++) {
          for (let tier = 0; tier <= winner; tier++) {
            await writeSkill(roots[tier], `precedence-${winner}`, `tier-${tier}-winner-${winner}`);
          }
        }
        const options = {
          config,
          agentId: "main",
          managedSkillsDir: roots[3],
          bundledSkillsDir: roots[1],
          pluginSkillsDir: path.join(home, "plugins"),
        };
        const skills = loadWorkspaceSkills(workspace, options);
        const snapshot = await buildSkillSnapshot(workspace, options);
        for (let winner = 0; winner < roots.length; winner++) {
          expect(
            skills.find((entry) => entry.skill.name === `precedence-${winner}`)?.skill,
          ).toMatchObject({
            description: `tier-${winner}-winner-${winner}`,
            filePath: path.join(roots[winner], `precedence-${winner}`, "SKILL.md"),
          });
          expect(snapshot.prompt).toContain(`tier-${winner}-winner-${winner}`);
          for (let loser = 0; loser < winner; loser++) {
            expect(snapshot.prompt).not.toContain(`tier-${loser}-winner-${winner}`);
          }
        }
        // P4: Workshop instructions retain an actionable absolute path even under an isolated HOME.
        expect(snapshot.prompt).toContain(path.join(roots[2], "precedence-2", "SKILL.md"));
      },
    );
  });

  it("P2/P3: excludes Workshop without agent/config or for workspace-only discovery, and never ships it to the workspace host", async () => {
    const home = tempDirs.make("workshop-placement-");
    await withEnvAsync(
      { HOME: home, OPENCLAW_HOME: undefined, OPENCLAW_STATE_DIR: undefined },
      async () => {
        const workspace = path.join(home, "workspace");
        const agentDir = path.join(home, "agent");
        const root = path.join(agentDir, "workshop-skills");
        await writeSkill(root, "gateway-procedure", "Gateway-only procedure");
        const config = {
          plugins: { enabled: false },
          agents: { entries: { main: { agentDir } } },
          skills: { load: { watch: false } },
        };
        const options = {
          config,
          agentId: "main",
          bundledSkillsDir: path.join(home, "bundled"),
          managedSkillsDir: path.join(home, "managed"),
        };
        expect(loadWorkspaceSkills(workspace, options).map((entry) => entry.skill.name)).toContain(
          "gateway-procedure",
        );
        for (const scoped of [
          { ...options, workspaceOnly: true },
          { ...options, agentId: undefined },
          { ...options, config: undefined },
        ]) {
          expect(
            loadWorkspaceSkills(workspace, scoped).map((entry) => entry.skill.name),
          ).not.toContain("gateway-procedure");
        }
        const split = splitSkillSourcePlan(resolveWorkspaceSkillSourcePlan(workspace, options));
        expect(split.gatewayPlan.roots.map((entry) => entry.dir)).toContain(root);
        expect(split.workspacePlan.roots.map((entry) => entry.dir)).not.toContain(root);
      },
    );
  });
});
