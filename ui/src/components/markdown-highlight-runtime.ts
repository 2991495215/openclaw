import hljs from "highlight.js/lib/core";
import { escapeHtml } from "../../../src/shared/html-escape.js";

const grammars = new Map([
  ["bash", () => import("highlight.js/lib/languages/bash")],
  ["cpp", () => import("highlight.js/lib/languages/cpp")],
  ["css", () => import("highlight.js/lib/languages/css")],
  ["diff", () => import("highlight.js/lib/languages/diff")],
  ["go", () => import("highlight.js/lib/languages/go")],
  ["java", () => import("highlight.js/lib/languages/java")],
  ["javascript", () => import("highlight.js/lib/languages/javascript")],
  ["json", () => import("highlight.js/lib/languages/json")],
  ["markdown", () => import("highlight.js/lib/languages/markdown")],
  ["python", () => import("highlight.js/lib/languages/python")],
  ["rust", () => import("highlight.js/lib/languages/rust")],
  ["typescript", () => import("highlight.js/lib/languages/typescript")],
  ["xml", () => import("highlight.js/lib/languages/xml")],
  ["yaml", () => import("highlight.js/lib/languages/yaml")],
]);
const languageAliases = new Map(
  Object.entries({
    bash: ["sh", "zsh", "shell"],
    cpp: ["cc", "c++", "h++", "hpp", "hh", "hxx", "cxx"],
    diff: ["patch"],
    go: ["golang"],
    java: ["jsp"],
    javascript: ["js", "jsx", "mjs", "cjs"],
    json: ["jsonc", "json5"],
    markdown: ["md", "mkdown", "mkd"],
    python: ["py", "gyp", "ipython"],
    rust: ["rs"],
    typescript: ["ts", "tsx", "mts", "cts"],
    xml: ["html", "xhtml", "rss", "atom", "xjb", "xsd", "xsl", "plist", "wsf", "svg"],
    yaml: ["yml"],
  }).flatMap(([language, aliases]) => aliases.map((alias) => [alias, language] as const)),
);

// Preserve the existing embedded-language closure. GraphQL and Ruby were never
// registered; their embedded regions continue to render as plain text.
const embeddedLanguages = new Map([
  ["javascript", ["xml", "css"]],
  ["typescript", ["xml", "javascript", "css"]],
  ["xml", ["javascript", "css"]],
  ["markdown", ["xml", "javascript", "css"]],
]);
const autoLanguages = [...grammars.keys()];
const grammarLoads = new Map<string, Promise<void>>();
const requests = new Map<string, { pending?: Promise<void>; ready: boolean }>();

function resolveLanguage(lang: string): string | undefined {
  const language = lang.trim().toLowerCase();
  return !language || grammars.has(language) ? language : languageAliases.get(language);
}

/** Load only this fence's grammar closure; unlabeled code retains full auto-detection. */
export function loadHighlightLanguage(lang: string): Promise<void> | undefined {
  const language = resolveLanguage(lang);
  if (language === undefined) {
    return undefined;
  }
  const existing = requests.get(language);
  if (existing) {
    return existing.pending;
  }
  const request: { pending?: Promise<void>; ready: boolean } = { ready: false };
  requests.set(language, request);
  const required = language
    ? [language, ...(embeddedLanguages.get(language) ?? [])]
    : autoLanguages;
  request.pending = Promise.allSettled(
    required.map((name) => {
      let load = grammarLoads.get(name);
      if (!load) {
        load = grammars.get(name)!().then(({ default: definition }) => {
          hljs.registerLanguage(name, definition);
          if (name === "bash") {
            hljs.registerAliases("shell", { languageName: "bash" });
          }
        });
        grammarLoads.set(name, load);
      }
      return load;
    }),
  ).then((results) => {
    request.pending = undefined;
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
    request.ready = true;
  });
  return request.pending;
}

/** Highlight a prepared snippet; failed or unsupported grammars stay escaped plain text. */
export function highlightCodeHtml(text: string, lang: string): string {
  const language = resolveLanguage(lang);
  try {
    if (language !== undefined && requests.get(language)?.ready) {
      if (language) {
        return hljs.highlight(text, { language, ignoreIllegals: true }).value;
      }
      if (text.trim()) {
        // Explicit order preserves ties regardless of which named fence loaded first.
        const result = hljs.highlightAuto(text, autoLanguages);
        if (result.relevance >= 2) {
          return result.value;
        }
      }
    }
  } catch {
    // Fall back to escaped plaintext; malformed input should not break chat rendering.
  }
  return escapeHtml(text);
}
