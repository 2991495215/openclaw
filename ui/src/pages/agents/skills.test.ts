import { describe, expect, it } from "vitest";
import type { SkillStatusReport } from "../../api/types.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createSkill } from "../skills/view.test-support.ts";
import { createAgentConfigActions } from "./agent-config-actions.ts";

describe("createAgentSkillActions", () => {
  it("snapshots reported skills without learned Workshop skills on the first toggle", () => {
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [
        createSkill({ name: "github", source: "openclaw-bundled" }),
        createSkill({ name: "weather", source: "openclaw-managed" }),
        createSkill({ name: "actual-budget-operations", source: "openclaw-workshop" }),
      ],
    };
    const runtimeConfig = createRuntimeConfigCapability({
      snapshot: { client: null, phase: "offline", sessionKey: "main" },
      subscribe: () => () => undefined,
    });

    try {
      const actions = createAgentConfigActions({
        getRuntimeConfig: () => runtimeConfig,
        getReport: () => report,
        canUpdate: () => true,
        onPrimaryChanged: () => undefined,
      }).skills;
      actions.onToggle("main", "weather", false);

      expect(runtimeConfig.state.configForm).toEqual({
        agents: { entries: { main: { skills: ["github"] } } },
      });
    } finally {
      runtimeConfig.dispose();
    }
  });
});
