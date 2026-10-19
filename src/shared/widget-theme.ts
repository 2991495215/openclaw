export const WIDGET_THEME_TOKEN_SOURCES = {
  surface: "--bg",
  card: "--card",
  elevated: "--bg-elevated",
  text: "--text",
  "text-strong": "--text-strong",
  muted: "--muted",
  border: "--border",
  "border-strong": "--border-strong",
  accent: "--accent",
  "accent-fill": "--primary",
  "accent-fg": "--primary-foreground",
  ok: "--ok",
  warn: "--warn",
  danger: "--danger",
  info: "--info",
  radius: "--radius",
  "radius-full": "--radius-full",
  "scrollbar-size": "--scrollbar-size",
  "scrollbar-thumb-inset": "--scrollbar-thumb-inset",
  "scrollbar-thumb": "--scrollbar-thumb",
  "scrollbar-thumb-hover": "--scrollbar-thumb-hover",
  "font-body": "--font-body",
  "font-mono": "--mono",
} as const;

export type WidgetThemeToken = keyof typeof WIDGET_THEME_TOKEN_SOURCES;

// SAFETY: The closed descriptor's own keys are the widget token vocabulary, in bridge order.
export const WIDGET_THEME_TOKENS = Object.keys(
  WIDGET_THEME_TOKEN_SOURCES,
) as readonly WidgetThemeToken[];

export const WIDGET_THEME_MESSAGE_TYPE = "openclaw:widget-theme";

export type WidgetThemeMessage = {
  type: typeof WIDGET_THEME_MESSAGE_TYPE;
  mode: "light" | "dark";
  tokens: Record<string, string>;
};
