import { collapseWhitespace as normalizeReefMessageText } from "openclaw/plugin-sdk/string-normalization-runtime";
import { bodyHash as hashMessageBody } from "../protocol/index.js";

export function reefMessageTextHash(text: string): string {
  return hashMessageBody({ text: normalizeReefMessageText(text) });
}

export function isRephrasedReefResend(text: string, originalTextHash: string | undefined): boolean {
  const normalized = normalizeReefMessageText(text);
  return (
    normalized.length > 0 &&
    originalTextHash !== undefined &&
    hashMessageBody({ text: normalized }) !== originalTextHash
  );
}
