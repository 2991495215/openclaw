import type { JSX } from "@solidjs/web";
import { lazy, Loading, Show } from "solid-js";

const Images = lazy(() => import("./chat-message-images-solid.tsx"), {
  export: "MessageImages",
});
const Attachments = lazy(() => import("./chat-message-attachments-solid.tsx"), {
  export: "AssistantAttachments",
});
export const MessageAttachment = withLoading(
  lazy(() => import("./chat-message-attachments-solid.tsx"), { export: "MessageAttachment" }),
);
export const ToolPreview = withLoading(
  lazy(() => import("./widget-card-view.tsx"), { export: "ToolPreview" }),
);
export const ChatClawHubCard = withLoading(
  lazy(() => import("./chat-clawhub-card.tsx"), { export: "ChatClawHubCard" }),
);

function withLoading<Props extends object>(Content: (props: Props) => JSX.Element) {
  return (props: Props) => (
    <Loading>
      <Content {...props} />
    </Loading>
  );
}

// Chat and pending New Session messages share these boundaries. Empty media
// collections must not load the renderers or the players they register.
export function MessageImages(
  props: Parameters<typeof import("./chat-message-images-solid.tsx").MessageImages>[0],
) {
  return (
    <Show when={props.images.length + (props.previews?.length ?? 0) > 0}>
      <Loading>
        <Images {...props} />
      </Loading>
    </Show>
  );
}

export function AssistantAttachments(
  props: Parameters<typeof import("./chat-message-attachments-solid.tsx").AssistantAttachments>[0],
) {
  return (
    <Show when={props.attachments.length > 0}>
      <Loading>
        <Attachments {...props} />
      </Loading>
    </Show>
  );
}
