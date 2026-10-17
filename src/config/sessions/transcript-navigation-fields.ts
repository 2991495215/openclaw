export const TRANSCRIPT_NAVIGATION_KEYS = [
  "type",
  "id",
  "parentId",
  "targetId",
  "appendParentId",
  "appendMode",
] as const;

/** Preserve own navigation fields, including malformed controls, without retaining payloads. */
export function projectTranscriptNavigationFields(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const navigation: Record<string, unknown> = {};
  for (const key of TRANSCRIPT_NAVIGATION_KEYS) {
    if (Object.hasOwn(record, key)) {
      navigation[key] = record[key];
    }
  }
  return navigation;
}
