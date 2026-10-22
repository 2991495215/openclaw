import { splitGraphemes } from "./ansi.js";

// Decorative emoji helpers that degrade cleanly on terminals without reliable emoji support.

/** Environment and terminal facts used to decide decorative emoji support. */
export type DecorativeEmojiOptions = {
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
  platform?: NodeJS.Platform;
};

const EMOJI_GRAPHEME_PATTERN = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;

/** Return true when decorative emoji should be emitted for the target terminal. */
export function supportsDecorativeEmoji(options: DecorativeEmojiOptions = {}): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isTty = options.isTty ?? process.stdout.isTTY;

  if (!isTty || (env.TERM ?? "").toLowerCase() === "dumb") {
    return false;
  }
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (locale && !/utf-?8/i.test(locale)) {
    return false;
  }
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
    Boolean(env.WT_SESSION) ||
    platform === "darwin"
  );
}

/** Return the emoji only when decorative emoji output is supported. */
export function decorativeEmoji(emoji: string, options: DecorativeEmojiOptions = {}): string {
  return supportsDecorativeEmoji(options) ? emoji : "";
}

/** Prefix text with a decorative emoji when supported. */
export function decorativePrefix(
  emoji: string,
  text: string,
  options: DecorativeEmojiOptions = {},
): string {
  const prefix = decorativeEmoji(emoji, options);
  return prefix ? `${prefix} ${text}` : text;
}

/** Strip decorative emoji for terminals that should not receive them. */
export function stripDecorativeEmojiForTerminal(
  text: string,
  options: DecorativeEmojiOptions = {},
): string {
  if (supportsDecorativeEmoji(options)) {
    return text;
  }
  return splitGraphemes(text)
    .filter((grapheme) => !EMOJI_GRAPHEME_PATTERN.test(grapheme))
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}
