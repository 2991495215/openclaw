export function decodeUtf8Input(bytes: Uint8Array, sourceLabel: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${sourceLabel} must be valid UTF-8.`, { cause: error });
  }
}

/** Decodes nonempty lowercase hex without replacing invalid UTF-8 or stripping a leading BOM. */
export function decodeUtf8HexInput(encoded: string): string | undefined {
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/.test(encoded)) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(encoded, "hex"),
    );
  } catch {
    return undefined;
  }
}
