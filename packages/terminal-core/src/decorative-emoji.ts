import { splitGraphemes } from "./ansi.js";

// Decorative emoji helpers that degrade cleanly on terminals without reliable emoji support.

const EMOJI_GRAPHEME_PATTERN = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;

/** Detect terminals with known emoji rendering support. */
function isKnownEmojiTerminal(env: NodeJS.ProcessEnv): boolean {
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  const term = (env.TERM ?? "").toLowerCase();
  return (
    termProgram.includes("iterm") ||
    termProgram.includes("apple_terminal") ||
    termProgram.includes("ghostty") ||
    termProgram.includes("wezterm") ||
    termProgram.includes("vscode") ||
    term.includes("ghostty") ||
    term.includes("wezterm") ||
    Boolean(env.WT_SESSION)
  );
}

/** Return true when locale variables indicate UTF-8 output support. */
function hasUtf8Locale(env: NodeJS.ProcessEnv): boolean {
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (!locale) {
    return true;
  }
  return /utf-?8/i.test(locale);
}

/** Return true when decorative emoji should be emitted for the target terminal. */
export function supportsDecorativeEmoji(): boolean {
  const env = process.env;

  return process.stdout.isTTY
    ? (env.TERM ?? "").toLowerCase() !== "dumb" &&
        hasUtf8Locale(env) &&
        (isKnownEmojiTerminal(env) || process.platform === "darwin")
    : false;
}

/** Return the emoji only when decorative emoji output is supported. */
export function decorativeEmoji(emoji: string): string {
  return supportsDecorativeEmoji() ? emoji : "";
}

/** Prefix text with a decorative emoji when supported. */
export function decorativePrefix(emoji: string, text: string): string {
  const prefix = decorativeEmoji(emoji);
  return prefix ? `${prefix} ${text}` : text;
}

/** Strip decorative emoji for terminals that should not receive them. */
export function stripDecorativeEmojiForTerminal(text: string): string {
  if (supportsDecorativeEmoji()) {
    return text;
  }
  return splitGraphemes(text)
    .filter((grapheme) => !EMOJI_GRAPHEME_PATTERN.test(grapheme))
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}
