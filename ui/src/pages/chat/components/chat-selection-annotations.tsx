import { lazy, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { AttachmentPreviewChip } from "./chat-attachment-preview-chip.tsx";
import { dispatchChatCommentAction } from "./chat-comment-action.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

const Content = lazy(() => import("./chat-selection-annotations-content.tsx"), {
  export: "ChatSelectionAnnotationsContent",
});

export function ChatSelectionAnnotations(props: ChatAttachmentControlsProps) {
  const count = () =>
    props.attachments?.filter((attachment) => attachment.selectionAnnotation).length ?? 0;
  return (
    <Show when={count() > 0}>
      <ChatLazyBoundary
        fallback={
          <openclaw-tooltip
            class="chat-comment-preview chat-comment-preview--editable"
            disabled
            inert
            aria-hidden="true"
          >
            <AttachmentPreviewChip
              label={t(
                count() === 1 ? "chat.messages.annotationCount" : "chat.messages.annotationsCount",
                { count: String(count()) },
              )}
              icon={<Icon name="messageSquare" />}
              removal={{
                label: t("chat.messages.removeAnnotations"),
                onRemove: (event) => dispatchChatCommentAction(event, undefined, "delete-all"),
                disabled: true,
              }}
            />
          </openclaw-tooltip>
        }
      >
        <Content {...props} />
      </ChatLazyBoundary>
    </Show>
  );
}
