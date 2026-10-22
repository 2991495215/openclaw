import { Show } from "solid-js";
import type { MenuHandle } from "../../../components/solid/menu.tsx";
import { ChatDetailsDesktopBody } from "./chat-details-desktop-body.tsx";
import { ChatDetailsProgress } from "./chat-details-progress.tsx";
import { ChatDetailsSession, type ChatDetailsSessionProps } from "./chat-details-session.tsx";

export type ChatDetailsDesktopCompositionProps = Omit<ChatDetailsSessionProps, "desktop"> & {
  /** The native host keeps ownership of top-layer menus and Undo/focus behavior. */
  progressMenuRef?: (menu: MenuHandle) => void;
  onHideProgress?: () => void;
};

/** Desktop entry point: one scroll body and the native Progress owner after Outputs. */
export function ChatDetailsDesktopComposition(props: ChatDetailsDesktopCompositionProps) {
  return (
    <ChatDetailsDesktopBody presented={props.presented}>
      <ChatDetailsSession
        props={props.props}
        presented={props.presented}
        dismissed={props.dismissed}
        desktop
      />
      <Show when={props.props?.progressCard}>
        <ChatDetailsProgress
          desktop
          props={props.props}
          presented={props.presented}
          menuRef={props.progressMenuRef}
          onHideProgress={props.onHideProgress}
        />
      </Show>
    </ChatDetailsDesktopBody>
  );
}
