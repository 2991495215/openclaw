/** JSON Pointer token helpers for file-backed secret refs. */
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";

/**
 * Encodes one JSON Pointer path token using RFC 6901 escaping.
 */
export function encodeJsonPointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Reads a value from a JSON-like document using an absolute JSON Pointer.
 * Missing segments throw.
 */
export function readJsonPointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) {
    throw new Error(
      'File-backed secret ids must be absolute JSON pointers (for example: "/providers/openai/apiKey").',
    );
  }

  let current: unknown = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      // Array segments must be canonical non-negative indexes, not partial parses like "1abc".
      const index = parseConfigPathArrayIndex(token);
      if (index === undefined || index >= current.length) {
        throw new Error(`JSON pointer segment "${token}" is out of bounds.`);
      }
      current = current[index];
      continue;
    }
    if (!isJsonObject(current) || !Object.hasOwn(current, token)) {
      throw new Error(`JSON pointer segment "${token}" does not exist.`);
    }
    current = current[token];
  }
  return current;
}
