/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-sharing.test/"} */

import { expect, it, onTestFinished, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import {
  createSharingTestChatPane,
  sessionRow,
  sharingResult,
} from "./chat-pane-sharing.test-support.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "./chat-pane.test-support.ts";

it("recovers sharing after a transient read failure without polling a healthy session", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const row = sessionRow();
  const request = vi
    .fn()
    .mockRejectedValueOnce(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Try later",
        retryable: true,
        retryAfterMs: 600_000,
      }),
    )
    .mockResolvedValue(sharingResult(row));
  const { pane } = createSharingTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: createSessionCapabilityFixture(),
  });
  await pane.loadSessionSharing(row);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  onTestFinished(() => visibility.mockRestore());
  pane.syncSharingReadRetryPresentation();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(request).toHaveBeenCalledOnce();
  visibility.mockReturnValue("visible");
  pane.syncSharingReadRetryPresentation();
  await vi.advanceTimersByTimeAsync(299_999);
  expect(request).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(
    pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key))?.result,
  ).toEqual(sharingResult(row));
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["retired", "forbidden"])("does not retry a %s sharing read", async (reason) => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const row = sessionRow();
  const request = vi.fn().mockRejectedValueOnce(
    new GatewayRequestError({
      code: reason === "forbidden" ? "FORBIDDEN" : "UNAVAILABLE",
      message: "Unavailable",
      retryable: reason !== "forbidden",
    }),
  );
  const { pane } = createSharingTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: createSessionCapabilityFixture(),
  });
  await pane.loadSessionSharing(row);
  if (reason === "retired") {
    pane.presented = false;
  }
  await vi.advanceTimersByTimeAsync(300_000);
  expect(request).toHaveBeenCalledOnce();
});
