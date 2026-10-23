export type ChatCommentAction = {
  id?: string;
  action: "edit" | "delete" | "delete-all";
  anchor?: HTMLElement;
  focusDelete?: (id: string) => void;
};

export function dispatchChatCommentAction(
  event: Event,
  id: string | undefined,
  action: ChatCommentAction["action"],
  context?: Pick<ChatCommentAction, "anchor" | "focusDelete">,
) {
  event.currentTarget?.dispatchEvent(
    new CustomEvent("openclaw-comment-action", {
      bubbles: true,
      composed: true,
      detail: { id, action, ...context },
    }),
  );
}
