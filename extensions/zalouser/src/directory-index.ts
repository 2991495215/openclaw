import { getOrCreateMapValue } from "openclaw/plugin-sdk/collection-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function buildZaloNameIndex<T>(
  items: T[],
  nameFn: (item: T) => string | undefined,
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const name = normalizeOptionalLowercaseString(nameFn(item));
    if (!name) {
      continue;
    }
    getOrCreateMapValue(index, name, () => []).push(item);
  }
  return index;
}
