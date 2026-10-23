import { createUniqueId, lazy, Show } from "solid-js";
import type { ApplicationContext } from "../../../app/context.ts";
import type { ToolPreview } from "../../../lib/chat/tool-cards.ts";
import { BrowserTabCardView, browserTabCardData } from "./browser-tab-card-view.tsx";
import { ChatImportBoundary } from "./chat-import-boundary.tsx";

export type BrowserTabCardProps = {
  context?: ApplicationContext;
  preview?: Extract<ToolPreview, { kind: "browser-tab" }>;
  revision?: string;
  latest?: boolean;
};

const BrowserTabCardRuntime = lazy(() => import("./browser-tab-card-runtime.tsx"), {
  export: "BrowserTabCardRuntime",
});

export function BrowserTabCardHost(props: BrowserTabCardProps) {
  let host!: HTMLElement;
  const menuId = createUniqueId();
  return (
    <openclaw-browser-tab-card ref={(element) => (host = element)}>
      <Show when={props.preview}>
        <ChatImportBoundary
          identity={[props.context, props.preview?.url, props.revision]}
          connected={() => host.isConnected}
          fallback={() => (
            <BrowserTabCardView data={browserTabCardData(props.preview)} menuId={menuId} pending />
          )}
        >
          <BrowserTabCardRuntime {...props} host={() => host} menuId={menuId} />
        </ChatImportBoundary>
      </Show>
    </openclaw-browser-tab-card>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-browser-tab-card": HTMLAttributes<HTMLElement>;
    }
  }
}
