const MAX_HOST_KEY_LENGTH = 16_384;
const OPENSSH_HOST_KEY_TYPE_PATTERN =
  /^(?:ssh|ecdsa-sha2|sk-(?:ssh|ecdsa-sha2))-[A-Za-z0-9@._+-]+$/u;
const OPENSSH_HOST_KEY_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

export function normalizeOpenSshHostKey(
  value: string,
  lineError: string,
  formatError: string,
): string {
  if (value.length > MAX_HOST_KEY_LENGTH || value.includes("\n") || value.includes("\r")) {
    throw new Error(lineError);
  }
  const tokens = value.trim().split(/\s+/u);
  const [algorithm, encodedKey] = tokens;
  if (
    tokens.length !== 2 ||
    !algorithm ||
    !encodedKey ||
    !OPENSSH_HOST_KEY_TYPE_PATTERN.test(algorithm) ||
    !OPENSSH_HOST_KEY_DATA_PATTERN.test(encodedKey) ||
    encodedKey.length % 4 !== 0
  ) {
    throw new Error(formatError);
  }
  return `${algorithm} ${encodedKey}`;
}
