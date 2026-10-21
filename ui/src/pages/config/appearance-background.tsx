import { action, createMemo, createOptimistic, Errored, Loading, onSettled } from "solid-js";
import { SessionBackground } from "../../components/session-background.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createAppearanceBackground } from "./appearance-background-state.ts";
import { AppearanceBackground as AppearanceBackgroundView } from "./view-appearance-background.tsx";

export function AppearanceBackground() {
  let host!: HTMLElement;
  const context = useApplication();
  let preview!: SessionBackground;
  let fileInput: HTMLInputElement | undefined;
  const state = createAppearanceBackground(
    context,
    () => host,
    () => preview,
    () => fileInput,
  );
  const [saving, setSaving] = createOptimistic(false, { equals: false });
  const result = createMemo(() => state.viewProps().mutation?.completion);
  const presentMutation = action(function* (completion: Promise<string | null>) {
    setSaving(true);
    yield completion;
  });
  function mutate(file?: File) {
    const completion = file ? state.viewProps().onFile(file) : state.viewProps().onRemoveImage();
    if (completion) {
      // Publish admission before the action holds its pending frame.
      onSettled(() => {
        void presentMutation(completion).catch(() => undefined);
      });
    }
  }
  return (
    <openclaw-appearance-background ref={(element) => (host = element)}>
      <SessionBackground
        class="settings-background-preview"
        data-background-preview-canvas
        ref={(element: SessionBackground) => {
          preview = element;
        }}
        context={context}
        surface="preview"
        presented={state.previewPresented()}
        preferenceOverride={state.previewPreference()}
      />
      <AppearanceBackgroundView
        {...state.viewProps()}
        busy={saving()}
        onFile={mutate}
        onRemoveImage={() => mutate()}
        status={
          state.viewProps().mutation && !state.viewProps().message ? (
            <Errored
              fallback={(error) => (
                <p role="alert" class="settings-status settings-status--danger">
                  {formatUiError(error())}
                </p>
              )}
            >
              <Loading
                fallback={
                  <p role="status" class="settings-status settings-status--muted">
                    {t(
                      `configView.appearance.background.${state.viewProps().mutation?.kind ?? "uploading"}`,
                    )}
                  </p>
                }
              >
                {result() ? (
                  <p role="status" class="settings-status settings-status--muted">
                    {result()}
                  </p>
                ) : undefined}
              </Loading>
            </Errored>
          ) : undefined
        }
        fileRef={(element) => {
          fileInput = element;
        }}
      />
    </openclaw-appearance-background>
  );
}
