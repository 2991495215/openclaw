import {
  parseCommandArgs,
  substituteArgs,
} from "../../../packages/agent-core/src/harness/prompt-template-arguments.js";
import type { SourceInfo } from "./source-info.js";

export interface PromptTemplate {
  name: string;
  description: string;
  argumentHint?: string;
  content: string;
  sourceInfo: SourceInfo;
  filePath: string; // Absolute path to the template file
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return text;
  }

  const templateName = match[1];
  const argsString = match[2] ?? "";

  const template = templates.find((t) => t.name === templateName);
  if (template) {
    const args = parseCommandArgs(argsString);
    return substituteArgs(template.content, args);
  }

  return text;
}
