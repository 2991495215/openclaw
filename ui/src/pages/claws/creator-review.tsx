import { createMemo, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { ModalDialog } from "../../components/modal-dialog.tsx";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { clawCreatorFlow } from "./creator-flow.ts";
import "../../styles/claw-creator.css";

const ClawReviewContent = lazy(() => import("./creator-review-content.tsx"), {
  export: "ClawReviewContent",
});

export function ClawCreatorReview(props: { context: ApplicationContext }) {
  const current = createMemo(() => {
    const flow = clawCreatorFlow(props.context);
    return { flow, view: projectOwner(flow, (owner) => owner) };
  });
  const flow = () => current().flow;
  const view = () => current().view;
  const reviewReceipt = createMemo(() => view().read().reviewRead);
  const reviewRead = createMemo(async () => {
    await reviewReceipt()?.result;
    return null;
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
    <>
      <Show when={view().read().modalOpen && view().read().review}>
        <ModalDialog
          label={t("clawsDraft.reviewTitle")}
          style={{ "--openclaw-modal-width": "720px" }}
          onModal-cancel={(event: Event) => {
            event.preventDefault();
            flow().close();
          }}
        >
          <Errored
            fallback={(error, reset) => (
              <LazyViewError
                error={error()}
                onRetry={reset}
                onClose={() => flow().close()}
                inline
              />
            )}
          >
            <Loading fallback={<p role="status">{t("common.loading")}</p>}>
              <ClawReviewContent
                flow={flow()}
                view={view()}
                reviewRead={reviewRead}
                reviewReceipt={reviewReceipt()}
              />
            </Loading>
          </Errored>
        </ModalDialog>
      </Show>
      <Show
        when={
          view().read().hasActiveDraft &&
          !view().read().modalOpen &&
          !view().read().publication &&
          view().read().error
        }
      >
        {(error) => (
          <div class="claw-creator__notice claw-creator__notice--error" role="alert">
            {error()}
            <button class="btn btn--sm" onClick={() => flow().retryReview()}>
              {t("clawsDraft.retryReview")}
            </button>
          </div>
        )}
      </Show>
      <Show
        when={
          view().read().review &&
          !view().read().modalOpen &&
          !view().read().publication &&
          !view().read().error
        }
      >
        <button class="claw-creator__reopen btn btn--sm" onClick={() => flow().reopen()}>
          {t("clawsDraft.reopen")}
        </button>
      </Show>
    </>
  );
}
