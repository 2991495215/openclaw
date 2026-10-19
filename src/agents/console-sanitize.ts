export function sanitizeForConsole(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = trimmed
    .replace(/\p{Cc}/gu, (control) => ("\r\n\t".includes(control) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
  const codePoints = Array.from(sanitized);
  if (codePoints.length <= 200) {
    return sanitized;
  }
  // Cap on code-point boundaries so truncation never splits a surrogate pair (emoji/astral) and
  // leaves a lone surrogate before the ellipsis.
  return `${codePoints.slice(0, 200).join("")}…`;
}
