import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { dedupeByKey } from "../../shared/dedupe-by-key.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";

/** Minimal descriptor shape used before a command is fully registered. */
type CommandDescriptorLike = Pick<NamedCommandDescriptor, "name" | "description" | "hidden">;

const SAFE_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Normalize and validate a command descriptor name for safe Commander registration. */
export function normalizeCommandDescriptorName(name: string): string | null {
  const normalized = name.trim();
  return SAFE_COMMAND_NAME_PATTERN.test(normalized) ? normalized : null;
}

/** Strip unsafe terminal content from descriptor descriptions. */
export function sanitizeCommandDescriptorDescription(description: string): string {
  return sanitizeForLog(description).trim();
}

/** Merge descriptor groups while keeping the first descriptor for each command name. */
export function collectUniqueCommandDescriptors<TDescriptor extends CommandDescriptorLike>(
  descriptorGroups: readonly (readonly TDescriptor[])[],
): TDescriptor[] {
  return dedupeByKey(descriptorGroups.flat(), (descriptor) => descriptor.name);
}
