import type { Skill } from "./skill-contract.js";
import { formatSkillsForPromptBounded } from "./skill-prompt-limits.js";

export type { Skill } from "./skill-contract.js";

/** Agent Skills catalog: https://agentskills.io/integrate-skills */
export function formatSkillsForPrompt(skills: Skill[]): string {
  return formatSkillsForPromptBounded({ skills: skills.filter((s) => !s.disableModelInvocation) });
}
