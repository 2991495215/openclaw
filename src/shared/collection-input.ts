import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function ensureRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = asOptionalRecord(root[key]);
  if (current) {
    return current;
  }
  const next: Record<string, unknown> = {};
  root[key] = next;
  return next;
}

export function normalizeOptionalTrimmedStringRecord(
  record: Record<string, unknown>,
): Record<string, string> | undefined {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const entry = normalizeOptionalString(value);
    if (entry) {
      normalized[key] = entry;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
