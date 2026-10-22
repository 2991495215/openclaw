import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureSkillLibraryPreparation,
  prepareSkillLibrarySelection,
} from "../../skills/library/selection.js";
import { resolveSkillRuntimeConfig } from "../../skills/loading/runtime-config.js";
import { prepareWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { normalizeWorkspaceSkillRoots } from "../../skills/loading/workspace-skill-roots.js";
import { resolveSkillSnapshotExecutionFileHost } from "../../skills/runtime/skill-snapshot-provenance.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION, type SkillEntry } from "../../skills/types.js";
import {
  mapSandboxSkillEntriesForPrompt,
  resolveSandboxSkillRuntimeInputs,
} from "./sandbox-skills.js";

type RuntimeSkillsPromptParams = Parameters<typeof resolveSandboxSkillRuntimeInputs>[0] & {
  config?: OpenClawConfig;
  agentId?: string;
  assertCurrent?: () => void;
  executionWorkspaceDir?: string;
  executionWorkspaceFileHost?: "gateway";
};

export async function prepareRuntimeSkillEntries(params: RuntimeSkillsPromptParams) {
  const inputs = resolveSandboxSkillRuntimeInputs(params);
  const { agentId, assertCurrent } = params;
  const shouldLoadSkillEntries =
    !inputs.skillsSnapshot ||
    (Boolean(inputs.skillsSnapshot.prompt.trim()) && !inputs.skillsSnapshot.resolvedSkills);
  const config = resolveSkillRuntimeConfig(params.config);
  // Materialized sandbox copies are the sole read root, including lazy rebuilds
  // of hydrated library snapshots that still carry their host provenance.
  const persistedRoots =
    inputs.skillsSnapshot?.promptFormatVersion === WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION
      ? inputs.skillsSnapshot.skillRoots
      : undefined;
  const skillRoots = normalizeWorkspaceSkillRoots(
    inputs.workspaceOnly
      ? { agentWorkspaceDir: inputs.skillsWorkspaceDir }
      : {
          agentWorkspaceDir: persistedRoots?.agentWorkspaceDir ?? inputs.skillsWorkspaceDir,
          executionWorkspaceDir:
            persistedRoots?.executionWorkspaceDir ?? params.executionWorkspaceDir,
          executionWorkspaceFileHost:
            params.executionWorkspaceFileHost ??
            resolveSkillSnapshotExecutionFileHost(inputs.skillsSnapshot),
        },
  );
  let cachedSkillEntries: SkillEntry[] | undefined;
  const loadSkillEntries = async (): Promise<SkillEntry[]> => {
    if (cachedSkillEntries) {
      return cachedSkillEntries;
    }
    assertCurrent?.();
    const preparation = captureSkillLibraryPreparation(
      inputs.workspaceOnly ? [] : (inputs.skillsSnapshot?.librarySelections ?? []),
      () => assertCurrent?.(),
    );
    const options = {
      config,
      agentId,
      executionWorkspaceDir: skillRoots.executionWorkspaceDir,
      executionWorkspaceFileHost: skillRoots.executionWorkspaceFileHost,
      ...(inputs.skillsEligibility ? { eligibility: inputs.skillsEligibility } : {}),
      ...(inputs.skillsSnapshot?.skillFilter
        ? { skillFilter: inputs.skillsSnapshot.skillFilter }
        : {}),
      ...(inputs.skillsSnapshot?.skillOverrides
        ? { skillOverrides: inputs.skillsSnapshot.skillOverrides }
        : {}),
      ...(inputs.workspaceOnly ? { workspaceOnly: true } : {}),
    };
    preparation.assertCurrent();
    const workspaceEntries = await prepareWorkspaceSkills(
      skillRoots.agentWorkspaceDir,
      options,
      assertCurrent,
    );
    preparation.assertCurrent();
    const libraryEntries = preparation.libraryContext
      ? await prepareSkillLibrarySelection(
          preparation.librarySelections,
          { env: preparation.libraryContext.environment },
          preparation.assertCurrent,
        )
      : undefined;
    preparation.assertCurrent();
    if (cachedSkillEntries) {
      return cachedSkillEntries;
    }
    cachedSkillEntries = libraryEntries
      ? [...workspaceEntries, ...libraryEntries]
      : workspaceEntries;
    return cachedSkillEntries;
  };
  return {
    ...inputs,
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries ? await loadSkillEntries() : [],
    loadSkillEntries,
    // Merged loading orders agent skills first so prompt caps keep their priority.
    preserveEntryOrder: skillRoots.executionWorkspaceDir !== undefined,
    mapEntries: (entries: SkillEntry[] | undefined) =>
      mapSandboxSkillEntriesForPrompt({
        entries,
        skillsWorkspaceDir: inputs.skillsWorkspaceDir,
        skillsPromptWorkspaceDir: inputs.skillsPromptWorkspaceDir,
      }),
  };
}

export async function resolveRuntimeSkillsPrompt(params: RuntimeSkillsPromptParams) {
  const prepared = await prepareRuntimeSkillEntries(params);
  const promptSkillEntries = prepared.mapEntries(
    prepared.shouldLoadSkillEntries ? prepared.skillEntries : undefined,
  );
  return {
    ...(params.sandbox ? { usagePaths: prepared.skillUsagePaths } : {}),
    prompt: await resolveSkillsPrompt({
      assertCurrent: params.assertCurrent,
      skillsSnapshot: prepared.skillsSnapshot,
      entries: promptSkillEntries,
      ...(params.sandbox ? {} : { loadEntries: prepared.loadSkillEntries }),
      workspaceDir: prepared.skillsPromptWorkspaceDir,
      config: params.config,
      agentId: params.agentId,
      eligibility: prepared.skillsEligibility,
      preserveEntryOrder: prepared.preserveEntryOrder,
    }),
  };
}
