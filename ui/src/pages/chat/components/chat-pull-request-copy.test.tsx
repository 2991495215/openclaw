/* @vitest-environment jsdom */
import { Show, createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../../../src/shared/deferred.ts";
import * as toast from "../../../lib/toast.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { PullRequestActions } from "./chat-pull-request-actions.tsx";
import { ChatPullRequestMobileDetail } from "./chat-pull-request-mobile.tsx";
import { pullRequest } from "./chat-pull-requests.test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountCopySurface(
  mode: "desktop" | "mobile",
  pr: () => ReturnType<typeof pullRequest>,
  visible: () => boolean = () => true,
) {
  const view = mountSolid(() => (
    <Show when={visible()}>
      {mode === "desktop" ? (
        <PullRequestActions
          label="Pull request actions"
          disabled={false}
          presented
          onDismiss={() => {}}
          pullRequest={pr()}
          owner={{ pullRequests: [pr()], status: "ready", onDismiss: () => {} }}
        />
      ) : (
        <ChatPullRequestMobileDetail pullRequest={pr()} hasSnapshot onDismiss={() => {}} />
      )}
    </Show>
  ));
  if (mode === "desktop") {
    view.getByRole("button", { name: "Pull request actions" }).click();
    await waitForSolid(() =>
      expect(view.queryByRole("menuitem", { name: "Copy PR link" })).not.toBeNull(),
    );
  }
  const copy = () =>
    view.getByRole(mode === "desktop" ? "menuitem" : "button", { name: "Copy PR link" });
  return { view, copy };
}

it.each(["desktop", "mobile"] as const)(
  "%s copy starts in the gesture and retires busy feedback on URL replacement and unmount",
  async (mode) => {
    const first = createDeferredCore();
    const second = createDeferredCore();
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal(
      "navigator",
      new Proxy(navigator, {
        get: (target, key) => (key === "clipboard" ? { writeText } : Reflect.get(target, key)),
      }),
    );
    const notice = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const [pr, setPr] = createSignal(pullRequest({ url: "https://example.test/first" }));
    const [visible, setVisible] = createSignal(true);
    const { view, copy } = await mountCopySurface(mode, pr, visible);
    copy().click();
    expect(writeText).toHaveBeenNthCalledWith(1, "https://example.test/first");
    await waitForSolid(() =>
      expect(
        copy().getAttribute("aria-disabled") === "true" || copy().hasAttribute("disabled"),
      ).toBe(true),
    );
    setPr(pullRequest({ url: "https://example.test/second" }));
    flush();
    await waitForSolid(() => {
      expect(copy().getAttribute("aria-disabled")).not.toBe("true");
      expect(copy().hasAttribute("disabled")).toBe(false);
    });
    copy().click();
    expect(writeText).toHaveBeenNthCalledWith(2, "https://example.test/second");
    await waitForSolid(() =>
      expect(
        copy().getAttribute("aria-disabled") === "true" || copy().hasAttribute("disabled"),
      ).toBe(true),
    );
    setVisible(false);
    flush();
    await waitForSolid(() => expect(view.container.textContent).toBe(""));
    first.resolve();
    second.resolve();
    await Promise.all([first.promise, second.promise]);
    await Promise.resolve();
    flush();
    expect(notice).not.toHaveBeenCalled();
  },
);

it.each(["desktop", "mobile"] as const)(
  "%s reports a failed current copy once through a toast",
  async (mode) => {
    const writeText = vi.fn().mockRejectedValue(new Error("Clipboard unavailable"));
    vi.stubGlobal(
      "navigator",
      new Proxy(navigator, {
        get: (target, key) => (key === "clipboard" ? { writeText } : Reflect.get(target, key)),
      }),
    );
    const original = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    onTestFinished(() => {
      if (original) {
        Object.defineProperty(document, "execCommand", original);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    });
    const notice = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const { view, copy } = await mountCopySurface(mode, () => pullRequest());
    copy().click();
    await waitForSolid(() => {
      expect(notice).toHaveBeenCalledOnce();
      expect(notice).toHaveBeenCalledWith(expect.objectContaining({ severity: "error" }));
      expect(copy().hasAttribute("disabled")).toBe(false);
      expect(copy().getAttribute("aria-disabled")).not.toBe("true");
    });
    expect(view.container.querySelector(".chat-pr-menu__error")).toBeNull();
    view.unmount();
  },
);
