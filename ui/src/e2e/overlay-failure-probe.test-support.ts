import type { Page } from "playwright";

declare global {
  interface Window {
    __openclawOverlayFailureProbe?: () => unknown;
  }
}

// HOLD diagnostic for synthetic Skills/Workboard fixtures; never land with product fixes.
export async function installOverlayFailureProbe(page: Page) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(
      ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError"].includes(error.name)
        ? error.name
        : "other",
    );
    if (pageErrors.length > 8) {
      pageErrors.shift();
    }
  });
  await page.addInitScript(() => {
    const labels = [
      "New card",
      "Review release readiness",
      "Card actions",
      "Edit card",
      "Import skill",
      "Create skill",
      "Save skill",
      "Close",
    ];
    const safeLabel = (value: unknown) =>
      typeof value === "string" && labels.includes(value.trim()) ? value.trim() : "other";
    const activeElement = () => {
      let element = document.activeElement;
      while (element?.shadowRoot?.activeElement) {
        element = element.shadowRoot.activeElement;
      }
      return element;
    };
    const identify = (element: Element | null) => {
      const control = element?.closest("button, input, textarea, form, .workboard-card");
      const name = control?.getAttribute("name");
      return {
        tag: element?.tagName.toLowerCase() ?? null,
        control:
          name === "library-slug" || name === "library-import-slug"
            ? name
            : control?.matches(".workboard-card")
              ? "workboard-card"
              : control?.matches(".workboard-draft__title")
                ? "workboard-title"
                : control?.matches(".skill-reader-dialog")
                  ? "skills-form"
                  : safeLabel(control?.getAttribute("aria-label") ?? control?.textContent),
      };
    };
    const slug = (name: string) => {
      const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      return input
        ? {
            matchesFixture: input.value === "checklist",
            length: input.value.length,
            disabled: input.disabled,
            valid: input.validity.valid,
            valueMissing: input.validity.valueMissing,
            patternMismatch: input.validity.patternMismatch,
            tooLong: input.validity.tooLong,
            customError: input.validity.customError,
          }
        : null;
    };
    const events: unknown[] = [];
    for (const type of ["focusin", "keydown", "click", "submit", "invalid"]) {
      document.addEventListener(
        type,
        (event) => {
          if (event instanceof KeyboardEvent && !["Enter", "Escape"].includes(event.key)) {
            return;
          }
          const target = event.composedPath().find((item) => item instanceof Element);
          events.push({
            type,
            target: identify(target instanceof Element ? target : null),
            active: identify(activeElement()),
            key: event instanceof KeyboardEvent ? event.key : null,
            submitter: event instanceof SubmitEvent ? identify(event.submitter) : null,
            slug:
              type === "click" || type === "submit" || type === "invalid"
                ? slug("library-slug")
                : null,
          });
          if (events.length > 32) {
            events.shift();
          }
        },
        true,
      );
    }
    const visible = (element: Element) =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    window.__openclawOverlayFailureProbe = () => {
      const create = [
        ...document.querySelectorAll<HTMLButtonElement>(".workboard-heading__actions button"),
      ].find((button) => button.textContent?.trim() === "New card");
      const save = [
        ...document.querySelectorAll<HTMLButtonElement>(".skill-reader-dialog button"),
      ].find((button) => button.textContent?.trim() === "Save skill");
      const knownErrors = [
        "The Gateway connection changed. Reopen the skill before saving.",
        "Sign in with a Gateway profile to create personal skills.",
        "Use at most 256 files, 1 MiB per file, and 8 MiB per bundle or ZIP.",
        "Choose SKILL.md together with its supporting files, or a folder containing SKILL.md at its root.",
        "The Gateway did not confirm the upload. Check your library before retrying the import.",
      ];
      return {
        active: identify(activeElement()),
        dialogs: [...document.querySelectorAll("openclaw-modal-dialog")].slice(0, 4).map((host) => {
          const dialog = host.shadowRoot
            ?.querySelector("wa-dialog")
            ?.shadowRoot?.querySelector("dialog");
          return {
            label: safeLabel(Reflect.get(host, "label")),
            open: dialog?.open ?? null,
            visible: dialog ? visible(dialog) : false,
          };
        }),
        newCard: create
          ? { disabled: create.disabled, expanded: create.getAttribute("aria-expanded") }
          : null,
        draftCount: document.querySelectorAll(".workboard-card-draft").length,
        detailsCount: document.querySelectorAll(".workboard-detail").length,
        skillSlug: slug("library-slug"),
        importSlug: slug("library-import-slug"),
        save: save ? { disabled: save.disabled, visible: visible(save), type: save.type } : null,
        visibleErrors: [...document.querySelectorAll('.skill-reader-dialog [role="alert"]')]
          .filter(visible)
          .slice(0, 4)
          .map((element) => {
            const text = element.textContent?.trim() ?? "";
            return knownErrors.includes(text) ? text : "<redacted>";
          }),
        events,
      };
    };
  });
  return async (scope: string) => {
    try {
      const snapshot = await page.evaluate(() => window.__openclawOverlayFailureProbe?.());
      console.error("SYNTHETIC_OVERLAY_FAILURE", JSON.stringify({ scope, pageErrors, snapshot }));
    } catch {
      console.error(
        "SYNTHETIC_OVERLAY_FAILURE",
        JSON.stringify({ scope, pageErrors, unavailable: true }),
      );
    }
  };
}
