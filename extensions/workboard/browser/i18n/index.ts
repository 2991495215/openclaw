import { createControlUiTranslator } from "openclaw/plugin-sdk/control-ui";
import { workboardLocale } from "../host.ts";
import { messages } from "./locales.ts";

export const t = createControlUiTranslator(messages, workboardLocale);
