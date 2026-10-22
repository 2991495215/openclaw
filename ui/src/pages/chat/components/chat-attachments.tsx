import { createMemo, For, lazy, Loading, Show } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import type { ChatAttachmentRead } from "./chat-attachment-reads.ts";

registerEnglishCatalog(registerChatComposerEnglish);

// Keep preview-only rendering out of empty composers, including New Session.
const AttachmentPreviewStrip = lazy(() => import("./chat-attachment-preview-strip.tsx"), {
  export: "AttachmentPreviewStrip",
});

// Keep the live region mounted so changes in the number of files are announced.
export function AttachmentReadStatus(props: { pendingReads: number }) {
  return (
    <div
      class="chat-attachments-status sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {props.pendingReads > 0
        ? t(
            props.pendingReads === 1
              ? "chat.composer.preparingAttachmentCount"
              : "chat.composer.preparingAttachmentsCount",
            { count: String(props.pendingReads) },
          )
        : undefined}
    </div>
  );
}

export type AttachmentPreviewEntry = Pick<
  ChatAttachmentRead,
  "attachment" | "state" | "progress" | "preparation" | "errorMessage"
> & {
  read: ChatAttachmentRead;
};

export function AttachmentPreview(
  props: ChatAttachmentControlsProps & {
    readRevision?: number | object;
    onChooseFiles?: () => void;
    getFocusFallback?: () => HTMLElement | null | undefined;
  },
) {
  const entries = createMemo(() => {
    void props.readRevision;
    const attachments = props.attachments ?? [];
    const reads =
      props.attachmentReads?.project(attachments) ??
      attachments.map((attachment): ChatAttachmentRead => ({ attachment, state: "ready" }));
    return reads.map((read): AttachmentPreviewEntry => ({
      read,
      attachment: read.attachment,
      state: read.state,
      progress: read.progress,
      preparation: read.preparation,
      errorMessage: read.errorMessage,
    }));
  });
  const failures = createMemo(() => {
    void props.readRevision;
    return props.attachmentReads?.failures ?? [];
  });
  const dismissButtons = new Map<string, HTMLButtonElement>();
  const dismiss = (id: string, event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
    const button = event.currentTarget;
    // Transfer keyboard focus before removal; pointer clicks and later failures do not move it.
    if (event.detail === 0 && button.ownerDocument.activeElement === button) {
      const current = failures();
      const index = current.findIndex((failure) => failure.id === id);
      const adjacent = current[index + 1] ?? current[index - 1];
      const target = adjacent ? dismissButtons.get(adjacent.id) : props.getFocusFallback?.();
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
      }
    }
    props.attachmentReads?.dismissFailure(id);
  };
  return (
    <>
      <Show when={entries().length > 0}>
        <Loading>
          <AttachmentPreviewStrip entries={entries()} controls={props} />
        </Loading>
      </Show>
      <div
        class={{ "chat-attachment-failures": failures().length > 0 }}
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
      >
        <Show when={failures().length > 0}>
          <ul class="chat-attachment-failures__list" aria-label={t("chat.attachments.notAttached")}>
            <For each={failures()}>
              {(failure) => {
                const dismissRef = elementRef((button: HTMLButtonElement) => {
                  dismissButtons.set(failure.id, button);
                  return () => dismissButtons.delete(failure.id);
                });
                return (
                  <li class="chat-attachment-failure">
                    <div>
                      <strong>{failure.fileName}</strong>
                      <span>{failure.message}</span>
                    </div>
                    <button
                      type="button"
                      ref={dismissRef}
                      class="btn btn--sm"
                      aria-label={t("chat.attachments.dismissError", { name: failure.fileName })}
                      onClick={(event) => dismiss(failure.id, event)}
                    >
                      {t("common.dismiss")}
                    </button>
                  </li>
                );
              }}
            </For>
          </ul>
          <Show when={props.onChooseFiles && uploadsEnabled(props.uploadConfig)}>
            <button
              type="button"
              class="btn btn--sm chat-attachment-failures__choose"
              disabled={props.disabled}
              onClick={() => props.onChooseFiles?.()}
            >
              {t("chat.attachments.chooseAgain")}
            </button>
          </Show>
        </Show>
      </div>
    </>
  );
}
