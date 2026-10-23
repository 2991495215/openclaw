/* @vitest-environment jsdom */

import type { ClawsDraftsReviewResult } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext } from "../skill-workshop/skill-workshop-page.test-support.ts";
import { clawCreatorFlow } from "./creator-flow.ts";
import { ClawCreatorReview } from "./creator-review.tsx";

const load = vi.hoisted(() => ({
  started: vi.fn(),
  ready: Promise.withResolvers<void>(),
}));

vi.mock("./creator-review-view.tsx", async (original) => {
  load.started();
  await load.ready.promise;
  return original();
});

afterEach(() => {
  cleanupSolid();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("loads review rendering only for an active draft and presents the review completed while loading", async () => {
  await i18n.setLocale("en");
  vi.useFakeTimers();
  const reviewed: ClawsDraftsReviewResult = {
    revision: "a".repeat(64),
    reviewToken: "b".repeat(64),
    publisher: "maker",
    name: "@maker/release-brief",
    displayName: "Release Brief",
    version: "0.1.0",
    description: "Summarizes releases",
    items: [],
    files: [],
    scope: {
      input: "A public repository",
      job: "Summarize releases",
      output: "A release brief",
      authority: "Read public sources only",
    },
  };
  const request = vi.fn(async (method: string) => {
    if (method === "claws.drafts.read") {
      return { revision: reviewed.revision, content: JSON.stringify({ scope: reviewed.scope }) };
    }
    if (method === "claws.drafts.review") {
      return reviewed;
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const context = createContext(request);
  context.router.subscribe = () => () => true;
  const page = mountSolid(() => <ClawCreatorReview context={context} />);
  await waitForSolid(() => expect(page.container.textContent).toBe(""));
  expect(load.started).not.toHaveBeenCalled();

  clawCreatorFlow(context).open("research", "ec8f46b0-4ca3-4991-8a73-dfdcc8764087");
  await waitForSolid(() => expect(load.started).toHaveBeenCalledOnce());
  expect(page.getByRole("status").textContent).toContain("Loading");
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "claws.drafts.read",
    "claws.drafts.review",
  ]);
  load.ready.resolve();
  await waitForSolid(() =>
    expect(page.getByLabelText<HTMLInputElement>("Name").value).toBe("Release Brief"),
  );
  expect(page.getByRole<HTMLButtonElement>("button", { name: "Publish to ClawHub" }).disabled).toBe(
    false,
  );
});
