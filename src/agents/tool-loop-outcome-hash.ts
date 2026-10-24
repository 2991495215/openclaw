import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "../infra/crypto-digest.js";

export function digestToolOutcome(value: unknown): string {
  // Copied or malformed envelopes may compare equal across encoded field boundaries.
  // This private loop hash grants no trust and never changes delivered content.
  const canonicalMarkerId = "0000000000000000";
  const serialized = stableStringify(value, (text) =>
    text.replace(
      /(<<<EXTERNAL_UNTRUSTED_CONTENT id=(\\*)")([a-f0-9]{16})(\2">>>(?:(?!<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT)[\s\S])*<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\2")\3(\2">>>)/g,
      `$1${canonicalMarkerId}$4${canonicalMarkerId}$5`,
    ),
  );
  return sha256Hex(serialized);
}
