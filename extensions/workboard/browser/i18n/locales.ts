import en from "./locales/en.ts";
import translated from "./locales/translated.json" with { type: "json" };
type TranslationMap = { readonly [key: string]: string | TranslationMap };

export const messages: Readonly<Record<string, TranslationMap>> = {
  en,
  ...translated,
};
