import { createEffect, createSignal, onCleanup } from "solid-js";
import { MarkdownDomReconciler, type MarkdownDomMedia } from "../lib/markdown-dom-reconciler.ts";
import { registerSessionTitleTarget } from "./session-title-target-registration.ts";

const STREAMING_FORMAT_INTERVAL_MS = 50;

export type MarkdownContentValue =
  | string
  | {
      messageKey: string;
      source: string;
      parts: readonly [string, string] | (() => readonly [string, string]);
      deferFormatting?: boolean;
    };

/** Bind a sanitized Markdown island without letting Solid render inside it. */
export function createMarkdownRef(
  read: () => {
    content: MarkdownContentValue;
    media?: MarkdownDomMedia;
    incremental?: boolean;
    connected?: boolean;
    onUpdate?: () => void;
  },
): (element: ParentNode) => void {
  // Fragment consumers attach during construction; ordinary element refs run unowned.
  const [owner, setOwner] = createSignal<MarkdownDomReconciler | undefined>(undefined, {
    ownedWrite: true,
  });
  let current: MarkdownDomReconciler | undefined;
  const [tick, setTick] = createSignal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let formattedAt = -Infinity;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  createEffect(
    () => {
      tick();
      const reconciler = owner();
      const value = read();
      const content = value.content;
      const remaining = STREAMING_FORMAT_INTERVAL_MS - (performance.now() - formattedAt);
      const preview = Boolean(
        reconciler &&
        typeof content !== "string" &&
        content.deferFormatting &&
        !value.media &&
        remaining > 0 &&
        reconciler.canPreview(content.messageKey, content.source),
      );
      // Formatting stays in the tracked phase: late code highlighting must still invalidate it.
      const parts =
        reconciler && !preview && typeof content !== "string"
          ? typeof content.parts === "function"
            ? content.parts()
            : content.parts
          : undefined;
      return { reconciler, value, preview, remaining, parts };
    },
    ({ reconciler, value, preview, remaining, parts }) => {
      if (!reconciler) {
        return;
      }
      reconciler.setConnected(value.connected ?? true);
      const content = value.content;
      if (preview && typeof content !== "string") {
        reconciler.preview(content.source);
        timer ??= setTimeout(() => {
          timer = undefined;
          setTick((previous) => previous + 1);
        }, remaining);
        return;
      }
      cancel();
      if (typeof content === "string") {
        reconciler.updateHtml(content, value.media, value.incremental);
      } else {
        reconciler.update(content.messageKey, content.source, parts!, value.media);
      }
      formattedAt = performance.now();
      value.onUpdate?.();
    },
  );
  onCleanup(() => {
    cancel();
    current?.dispose();
  });
  return (element) => {
    cancel();
    formattedAt = -Infinity;
    current?.dispose();
    // Create the boundary synchronously so a fragment caller can return its markers.
    current = new MarkdownDomReconciler(element, registerSessionTitleTarget);
    setOwner(current);
  };
}
