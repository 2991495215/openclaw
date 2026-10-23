import { createMemo, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { clawCreatorFlow } from "./creator-flow.ts";
import "../../styles/claw-creator.css";

const ReviewView = lazy(() => import("./creator-review-view.tsx"), {
  export: "ClawCreatorReviewView",
});

export function ClawCreatorReview(props: { context: ApplicationContext }) {
  const current = createMemo(() => {
    const flow = clawCreatorFlow(props.context);
    return { flow, view: projectOwner(flow, (owner) => owner) };
  });
  onSettled(() => {
    const context = props.context;
    const owner = clawCreatorFlow(context);
    const pathname = context.router.getState().location.pathname;
    return context.router.subscribe(() => {
      if (context.router.getState().location.pathname !== pathname) {
        owner.retirePresentation();
      }
    });
  });
  return (
    <Show when={current().view.read().hasActiveDraft}>
      <Errored
        fallback={(error, reset) => (
          <div class="claw-creator__notice claw-creator__notice--error">
            <LazyViewError
              error={error()}
              stale={isStaleChunkImportError(error())}
              onRetry={() =>
                isStaleChunkImportError(error())
                  ? void retryStaleChunkReloadWhenReachable()
                  : reset()
              }
              inline
            />
          </div>
        )}
      >
        <Loading
          fallback={
            <div class="claw-creator__notice" role="status">
              {t("common.loading")}
            </div>
          }
        >
          <ReviewView flow={current().flow} view={current().view} />
        </Loading>
      </Errored>
    </Show>
  );
}
