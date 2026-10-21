import { createComponent, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as assistantIdentity from "../../app/assistant-identity.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createChatPageStateContext } from "./chat-state-context.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { ChatImageLightbox } from "./components/chat-image-lightbox-view.tsx";
import { AssistantAttachments } from "./components/chat-message-attachments-solid.tsx";

beforeEach(() => {
  vi.spyOn(assistantIdentity, "loadLocalAssistantIdentity").mockReturnValue({
    avatar: "data:image/png;base64,bG9jYWw=",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("image lightbox lifecycle", () => {
  it("accepts only matching base64 video at the page boundary", () => {
    const state = createPageState(
      createChatPageStateContext(),
      { afterCommit: () => () => {} },
      { dispatchEvent: () => true },
    );

    const source = "data:video/mp4;base64,AAAA";
    const mounted = mountSolid(() =>
      createComponent(AssistantAttachments, {
        attachments: [
          {
            type: "attachment",
            attachment: { kind: "video", label: "Clip", mimeType: "video/mp4", url: source },
          },
        ],
        options: { onOpenImage: state.handleOpenImage },
      }),
    );
    const { container } = mounted;
    const player = container.querySelector("openclaw-chat-video-player") as HTMLElement & {
      onExpand: (src: string) => void;
    };
    player.onExpand(source);
    expect(state.imageLightbox?.src).toBe("data:video/mp4;base64,AAAA");

    state.handleOpenImage({ kind: "video", src: "data:audio/mp3;base64,AAAA", title: "Audio" });
    expect(state.imageLightbox).toBeNull();
    mounted.unmount();
  });

  it("clears the mounted preview when beginning a deferred image open", () => {
    onTestFinished(installDialogPolyfill());
    const state = createPageState(
      createChatPageStateContext(),
      { afterCommit: () => () => {} },
      { dispatchEvent: () => true },
    );
    const release = vi.fn();
    state.imageLightbox = {
      src: "blob:managed-image",
      title: "Generated image",
      release,
    };
    const mounted = mountSolid(() =>
      createComponent(ChatImageLightbox, {
        get item() {
          return state.imageLightbox;
        },
        onClose: state.handleCloseImage,
      }),
    );
    onTestFinished(async () => {
      mounted.unmount();
      await vi.dynamicImportSettled();
    });
    expect(mounted.container.querySelector("openclaw-image-lightbox")).not.toBeNull();

    const requestVersion = state.beginImageOpen();

    expect(requestVersion).toBe(1);
    expect(state.imageLightbox).toBeNull();
    expect(release).toHaveBeenCalledOnce();
    flush();
    expect(mounted.container.querySelector("openclaw-image-lightbox")).toBeNull();
  });
});
