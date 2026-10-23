import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/composer.css";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSelectionAnnotations } from "./chat-selection-annotations.tsx";

const loading = vi.hoisted(() => ({ ...Promise.withResolvers<void>(), started: false }));

// Hold the real renderer to exercise the first-annotation loading boundary.
vi.mock("./chat-selection-annotations-content.tsx", async (original) => {
  loading.started = true;
  await loading.promise;
  return original();
});

it("loads on the first annotation without changing chip size or replacing loaded controls", async () => {
  onTestFinished(loading.resolve);
  const annotation: ChatAttachment = {
    id: "comment",
    mimeType: "text/plain",
    selectionAnnotation: {
      text: "Selected passage",
      comment: "Original comment",
      sessionKey: "agent:main:main",
      start: 0,
      end: 16,
    },
  };
  const [attachments, setAttachments] = createSignal<ChatAttachment[]>([]);
  const view = mountSolid(() => <ChatSelectionAnnotations attachments={attachments()} />);
  onTestFinished(view.unmount);
  document.body.append(view.container);
  view.container.style.cssText = "display: flex; width: 460px";
  flush();
  expect(loading.started).toBe(false);
  expect(view.container.querySelector(".chat-selection-annotations__chip")).toBeNull();

  setAttachments([annotation]);
  await waitForSolid(() => expect(loading.started).toBe(true));
  const placeholder = view.container.querySelector<HTMLElement>("[inert]")!;
  expect(placeholder).not.toBeNull();
  await document.fonts.ready;
  const pendingBounds = placeholder
    .querySelector(".chat-selection-annotations__chip")!
    .getBoundingClientRect();
  expect(pendingBounds.width).toBeGreaterThan(0);
  expect(pendingBounds.height).toBeGreaterThan(0);

  loading.resolve();
  await waitForSolid(() => expect(view.container.querySelector("[inert]")).toBeNull());
  const chip = view.container.querySelector<HTMLElement>(".chat-selection-annotations__chip")!;
  expect(chip.getBoundingClientRect().width).toBeCloseTo(pendingBounds.width, 1);
  expect(chip.getBoundingClientRect().height).toBeCloseTo(pendingBounds.height, 1);
  const edit = view.container.querySelector('button[aria-label="Edit comment 1"]')!;
  expect(edit).not.toBeNull();

  setAttachments([
    {
      ...annotation,
      selectionAnnotation: { ...annotation.selectionAnnotation!, comment: "Updated" },
    },
  ]);
  await waitForSolid(() => expect(view.container.textContent).toContain("Updated"));
  expect(view.container.querySelector(".chat-selection-annotations__chip")).toBe(chip);
  expect(view.container.querySelector('button[aria-label="Edit comment 1"]')).toBe(edit);
  setAttachments([]);
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-selection-annotations__chip")).toBeNull(),
  );
});
