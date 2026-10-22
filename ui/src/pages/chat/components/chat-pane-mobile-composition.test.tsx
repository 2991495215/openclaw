/* @vitest-environment jsdom */
import { dynamic } from "@solidjs/web";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import * as toast from "../../../lib/toast.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  composerFixture,
  people,
  resetMentionComposerFixture,
} from "../chat-composer-mentions.test-support.ts";
import type { ChatMobileHost } from "../chat-mobile-host.ts";
import { createChatMobilePeopleMentions } from "../chat-mobile-people-mentions.ts";
import { offlineDeviceSession } from "../chat-pane.test-support.ts";
import { mountChatPaneHeader } from "./chat-pane-header.test-support.ts";
import type { ChatPaneHeaderProps } from "./chat-pane-header.types.ts";

const containers: HTMLElement[] = [];
afterEach(resetMentionComposerFixture);

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  vi.restoreAllMocks();
});

function mountHeader(patch: Partial<ChatPaneHeaderProps> = {}) {
  return mountChatPaneHeader(containers, patch);
}

it("clears the device name while replacing its request and ignores retired results", async () => {
  const first = createDeferred<string | undefined>();
  const obsolete = createDeferred<string | undefined>();
  const current = createDeferred<string | undefined>();
  const readFirst = vi.fn(() => first.promise);
  const mounted = mountHeader({ session: offlineDeviceSession(), readMachineName: readFirst });
  const name = () => mounted.container.querySelector(".chat-pane__device-name")?.textContent;
  expect(name()).toBeUndefined();
  first.resolve("First device");
  await waitForSolid(() => expect(name()).toBe("First device"));
  const title = mounted.container.querySelector(".chat-pane__session-title");
  mounted.update({ title: "Updated session title" });
  expect(readFirst).toHaveBeenCalledOnce();
  expect(name()).toBe("First device");
  mounted.update({ readMachineName: () => obsolete.promise });
  expect(name()).toBeUndefined();
  mounted.update({ readMachineName: () => current.promise });
  obsolete.resolve("Retired device");
  await obsolete.promise;
  expect(name()).toBeUndefined();
  current.resolve("Current device");
  await waitForSolid(() => expect(name()).toBe("Current device"));
  expect(mounted.container.querySelector(".chat-pane__session-title")).toBe(title);
  mounted.update({ readMachineName: undefined });
  expect(name()).toBeUndefined();
});

it("retains the People page and pauses its lookup across native host replacement and desktop parking", async () => {
  const composer = composerFixture("chat", "Keep this draft");
  vi.spyOn(toast, "showToast").mockReturnValue(true);
  const nativeMentions = createChatMobilePeopleMentions(composer.mentionAccess);
  const release = Object.assign(vi.fn(), { setPresented: vi.fn() });
  const mentions = {
    ...nativeMentions,
    activate: vi.fn((presented = true) => {
      const activation = nativeMentions.activate(presented);
      return Object.assign(
        () => {
          release();
          activation();
        },
        {
          setPresented: (next: boolean) => {
            release.setPresented(next);
            activation.setPresented(next);
          },
        },
      );
    }),
  };
  const mobileHost: ChatMobileHost = {
    scopeKey: "people-retention",
    open: false,
    suspended: false,
    mode: "expanded",
    height: undefined,
    reservedHeight: 0,
    destination: { area: "panels" },
    detailsMount: null,
    setDetailsMount: vi.fn(),
    navigate: (destination) => {
      mobileHost.open = true;
      mobileHost.destination = destination;
      refreshHost();
    },
    reveal: vi.fn(),
    close: vi.fn(),
    back: vi.fn(),
    toggleExpanded: vi.fn(),
    resize: vi.fn(),
    keyboardVisible: false,
    onComposerEditingChange: vi.fn(),
    onViewportChange: vi.fn(),
  };
  const detailsControl = {
    chat: undefined,
    elements: {},
    mobile: true,
    mobileHost,
    presentation: true,
    setRef: vi.fn(),
  };
  const mounted = mountHeader({
    mergedChrome: true,
    detailsControl,
    mobilePeople: {
      header: [
        { key: "ada", sender: { name: "Ada" }, label: "Ada", firstName: "Ada", viewing: true },
      ],
      viewers: [],
      participants: [
        {
          key: "alex",
          sender: { name: "Alex" },
          label: "Alex",
          firstName: "Alex",
          viewing: false,
          mention: people.users[0],
        },
      ],
      unlistedParticipantCount: 0,
      participantsComplete: false,
    },
    mobilePeopleMentions: mentions,
  });
  function refreshHost() {
    mounted.update({ detailsControl: { ...detailsControl, mobileHost: { ...mobileHost } } });
  }
  const trigger = mounted.container.querySelector<HTMLButtonElement>(".chat-mobile-people-grid")!;
  expect(mentions.activate).not.toHaveBeenCalled();
  trigger.click();
  const renderPage = mobileHost.destination.page!.render!;
  const mountPage = () =>
    mountSolid(() => {
      const Page = dynamic(() => renderPage);
      return <Page />;
    });
  const firstPage = mountPage();
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() =>
    expect(firstPage.queryByRole("group", { name: "People" })).not.toBeNull(),
  );
  const retainedPage = firstPage.container.querySelector("#pane-1-mobile-people");
  expect(retainedPage).not.toBeNull();
  expect(mentions.activate).toHaveBeenCalledOnce();
  composer.setUnsupported();
  await vi.advanceTimersByTimeAsync(0);
  expect(nativeMentions.status).toBe("unavailable");
  composer.setUnsupported(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(nativeMentions.status).toBe("ready");
  expect(composer.request).toHaveBeenCalledTimes(2);
  expect(mentions.activate).toHaveBeenCalledOnce();
  expect(firstPage.container.querySelector("#pane-1-mobile-people")).toBe(retainedPage);
  composer.container.querySelector<HTMLTextAreaElement>("textarea")!.readOnly = true;
  firstPage.getByRole("button", { name: "Mention Alex" }).click();
  mounted.update({ mobilePeopleMentions: { ...mentions, status: nativeMentions.status } });
  expect(nativeMentions.status).toBe("insert-rejected");
  expect(mobileHost.open).toBe(true);
  expect(mobileHost.close).not.toHaveBeenCalled();
  expect(composer.value()).toEqual({ draft: "Keep this draft", mentions: [] });
  expect(firstPage.queryByRole("alert")).toBeNull();
  expect(firstPage.queryByRole("button", { name: "Retry" })).toBeNull();
  mounted.update({
    title: "Updated title",
    mobilePeopleMentions: { ...mentions, status: "loading" },
  });
  mounted.update({
    mergedChrome: false,
    detailsControl: { ...detailsControl, mobileHost: undefined },
  });
  await waitForSolid(() => expect(release.setPresented).toHaveBeenLastCalledWith(false));
  mounted.update({ mergedChrome: true, detailsControl });
  await waitForSolid(() => expect(release.setPresented).toHaveBeenLastCalledWith(true));
  mobileHost.suspended = true;
  refreshHost();
  await waitForSolid(() => expect(release.setPresented).toHaveBeenLastCalledWith(false));
  mobileHost.suspended = false;
  refreshHost();
  await waitForSolid(() => expect(release.setPresented).toHaveBeenLastCalledWith(true));
  expect(mounted.container.querySelector(".chat-mobile-people-grid")).toBe(trigger);
  expect(mentions.activate).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  firstPage.unmount();
  mobileHost.open = false;
  refreshHost();
  expect(release).toHaveBeenCalledOnce();
  mounted.update({
    mergedChrome: false,
    detailsControl: { ...detailsControl, mobileHost: undefined },
    mobilePeopleMentions: { ...mentions, status: "error" },
  });
  mobileHost.open = true;
  mounted.update({ mergedChrome: true, detailsControl });
  const returnedPage = mountPage();
  expect(returnedPage.container.querySelector("#pane-1-mobile-people")).toBe(retainedPage);
  expect(returnedPage.queryByRole("alert")).toBeNull();
  expect(returnedPage.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(mentions.activate).toHaveBeenCalledTimes(2);
  mounted.unmount();
  expect(release).toHaveBeenCalledTimes(2);
  expect(renderPage()).toBeUndefined();
  returnedPage.unmount();
});
