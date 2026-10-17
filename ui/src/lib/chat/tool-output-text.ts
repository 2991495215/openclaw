import { asNullableObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";

export function extractToolOutputText(value: unknown): string | null {
  const record = readRecord(value);
  if (!record) {
    return null;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  if (!Array.isArray(record.content)) {
    return null;
  }
  const parts: string[] = [];
  for (const content of record.content) {
    const entry = readRecord(content);
    if (entry?.type === "text" && typeof entry.text === "string" && entry.text) {
      parts.push(entry.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
