import { Errored, Loading, Show, lazy, onSettled, useContext } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../../app/stale-chunk-reload.ts";
import { PanelFeedback, PanelFeedbackScope } from "../../../components/solid/panel-feedback.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { StatusWarning, type ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import { hasChatPullRequests } from "./chat-pull-requests.ts";

export type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";

export function ChatPullRequests(props: ChatPullRequestsProps) {
  const parentPresented = useContext(ContentPresentation);
  const Content = lazy(() => import("./chat-pull-requests-content.tsx"), {
    export: "ChatPullRequestsContent",
  });
  return (
    <PanelFeedbackScope>
      <StatusWarning status={props.status} />
      <Show when={hasChatPullRequests(props)}>
        <Errored
          fallback={(error, reset) => {
            let active = true;
            onSettled(() => () => {
              active = false;
            });
            const retry = () => {
              if (!active) {
                return;
              }
              const failure = error();
              if (!isStaleChunkImportError(failure)) {
                reset();
                return;
              }
              const sessionKey = props.sessionKey;
              const sessionId = props.sessionId;
              const gateway = props.gateway;
              void retryStaleChunkReloadWhenReachable({
                canReload: () => {
                  const presented = props.presented;
                  return (
                    active &&
                    error() === failure &&
                    props.sessionKey === sessionKey &&
                    props.sessionId === sessionId &&
                    props.gateway === gateway &&
                    hasChatPullRequests(props) &&
                    !props.dismissed &&
                    parentPresented() &&
                    (typeof presented === "object" ? presented.isPresented() : (presented ?? true))
                  );
                },
              });
            };
            return (
              <PanelFeedback
                label={t("sessionHovercard.pullRequests")}
                message={formatUiError(error(), t("lazyView.errorTitle"))}
                onRetry={retry}
                recovery={isStaleChunkImportError(error()) ? "reload" : "retry"}
              />
            );
          }}
        >
          <Loading
            fallback={
              <div class="chat-prs">
                <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
              </div>
            }
          >
            <Content {...props} />
          </Loading>
        </Errored>
      </Show>
    </PanelFeedbackScope>
  );
}
