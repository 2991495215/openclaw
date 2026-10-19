import { createControlUiTranslator } from "openclaw/plugin-sdk/control-ui";
import { messages } from "./locales.ts";

export function createTranslator(locale: () => string) {
  return createControlUiTranslator(messages, locale);
}
