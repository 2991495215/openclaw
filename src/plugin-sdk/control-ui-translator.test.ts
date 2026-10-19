import { describe, expect, it } from "vitest";
import { createControlUiTranslator } from "./control-ui.js";

describe("createControlUiTranslator", () => {
  it("reads the current locale and falls back to English for absent translations", () => {
    let locale = "de";
    const t = createControlUiTranslator(
      {
        en: { greeting: "Hello {name}", nested: { fallback: "English" }, empty: "Not empty" },
        de: { greeting: "Hallo {name}", empty: "" },
      },
      () => locale,
    );

    expect(t("greeting", { name: "Ada" })).toBe("Hallo Ada");
    expect(t("nested.fallback")).toBe("English");
    expect(t("empty")).toBe("");
    locale = "en";
    expect(t("greeting", { name: "Ada" })).toBe("Hello Ada");
    locale = "unknown";
    expect(t("nested.fallback")).toBe("English");
  });

  it("retains unresolved placeholders and returns the key for missing or non-text values", () => {
    const t = createControlUiTranslator(
      {
        en: { message: "{name}: {count} {name} {hyphen-name}", section: "English text" },
        de: { section: { title: "Titel" } },
      },
      () => "de",
    );

    expect(t("message", { name: "", count: "3" })).toBe(": 3  {hyphen-name}");
    expect(t("message")).toBe("{name}: {count} {name} {hyphen-name}");
    expect(t("missing.key")).toBe("missing.key");
    expect(t("section")).toBe("section");
    expect(t("section.title.child")).toBe("section.title.child");
  });
});
